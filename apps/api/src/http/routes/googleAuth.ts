// Sign in with Google (OAuth 2.0 Authorization Code + PKCE). A successful login mints the SAME
// `rw_session` cookie as the wallet and claim-code paths — for owner id `google_<sub>` — so the rest
// of the app treats a Google user like any other walletless owner (SPEC-V2 §6, owner.ts).
//
// Security: a short-lived signed cookie carries the CSRF `state` and the PKCE verifier across the
// redirect; the callback rejects a mismatched state. The id_token is fetched over TLS from Google's
// token endpoint with the confidential client secret, and its `aud`/`iss`/`exp` are verified before
// `sub` is trusted. These routes are GET (exempt from the x-vantra-client CSRF guard by design), and
// the OAuth state param is their CSRF protection. Every Google response is validated with a schema.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { googleOwnerId } from '@vantra/shared';
import { ensureCustodialWallet } from '../../economy/custodial.js';
import type { Deps } from '../../core/interfaces.js';
import type { Auth } from '../auth.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_COOKIE = 'rw_goauth';
const OAUTH_TTL_S = 600;
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const CallbackQuery = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() });
const TokenResponse = z.object({ id_token: z.string() });
const IdTokenClaims = z.object({ sub: z.string(), aud: z.string(), iss: z.string(), exp: z.number() });

export async function googleAuthRoutes(app: FastifyInstance, deps: Deps, auth: Auth): Promise<void> {
  const google = deps.config.auth.google;
  if (!google) return;   // button off unless GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are both set
  const { log } = deps;
  const redirectUri = `${deps.config.apiUrl}/api/auth/google/callback`;
  const cookieOpts = {
    path: '/api/auth/google', httpOnly: true, sameSite: 'lax' as const,
    secure: deps.config.isProduction, signed: true, maxAge: OAUTH_TTL_S,
  };

  app.get('/api/auth/google/start', async (_request, reply) => {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    reply.setCookie(OAUTH_COOKIE, `${state}.${verifier}`, cookieOpts);
    const params = new URLSearchParams({
      client_id: google.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256',
      access_type: 'online', prompt: 'select_account',
    });
    return reply.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  app.get('/api/auth/google/callback', async (request, reply) => {
    const q = CallbackQuery.safeParse(request.query);
    // Never leak the reason in the URL; the log has it.
    const fail = (why: string) => { log.warn({ why }, 'google login failed'); return reply.redirect(`${deps.config.publicUrl}/mine?login=failed`); };

    const raw = request.cookies[OAUTH_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    reply.clearCookie(OAUTH_COOKIE, { path: cookieOpts.path });
    if (!q.success || q.data.error || !q.data.code || !q.data.state) return fail(q.success ? (q.data.error ?? 'missing code/state') : 'bad query');
    if (!unsigned?.valid) return fail('no oauth cookie');
    const [cookieState, verifier] = unsigned.value.split('.');
    if (!cookieState || !verifier || cookieState !== q.data.state) return fail('state mismatch');

    let idToken: string;
    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: google.clientId, client_secret: google.clientSecret, code: q.data.code,
          redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
        }),
      });
      if (!res.ok) return fail(`token exchange ${res.status}`);
      const parsed = TokenResponse.safeParse(await res.json());
      if (!parsed.success) return fail('no id_token');
      idToken = parsed.data.id_token;
    } catch (e) {
      return fail(`token error ${e instanceof Error ? e.message : String(e)}`);
    }

    const claims = parseIdToken(idToken);
    if (!claims) return fail('bad id_token');
    if (claims.aud !== google.clientId) return fail('aud mismatch');
    if (!ISSUERS.includes(claims.iss)) return fail('iss mismatch');
    if (claims.exp < Math.floor(Date.now() / 1000)) return fail('id_token expired');

    const ownerId = googleOwnerId(claims.sub);
    await auth.signIn(reply, ownerId);
    // Provision the server-held wallet now so /mine shows a deposit address on first login. Best-effort:
    // the wallet endpoints also create it lazily, so a transient failure here never blocks sign-in.
    try { await ensureCustodialWallet(deps, ownerId); } catch (e) { log.warn({ err: e }, 'custodial wallet provisioning deferred'); }
    return reply.redirect(`${deps.config.publicUrl}/mine`);
  });
}

// The token comes directly from Google's token endpoint over TLS with our client secret, so decoding
// the payload and checking aud/iss/exp is sufficient (no JWKS signature check needed for this flow).
function parseIdToken(jwt: string): z.infer<typeof IdTokenClaims> | null {
  const payload = jwt.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = IdTokenClaims.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
