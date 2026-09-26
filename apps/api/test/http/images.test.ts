// POST /api/images takes the raw image as the body. The app's global body limit is 256 KB, so this
// route must carry its own, or a perfectly ordinary logo is refused before it reaches Services.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_MAX_BYTES, type ApiErrorBody } from '@vantra/shared';
import { BODY_LIMIT_BYTES } from '../../src/http/server.js';
import { buildTestApp, json, web, type TestApp } from './helpers/app.js';
import { OWNER_A } from './helpers/fixtures.js';

let t: TestApp;
let cookie: string;

beforeEach(async () => {
  t = await buildTestApp();
  cookie = await t.signIn(OWNER_A);
});
afterEach(async () => { await t?.close(); });

const upload = (payload: Buffer, contentType = 'image/png', withCookie = true) => t.app.inject(web({
  method: 'POST', url: '/api/images', payload,
  headers: { 'content-type': contentType, ...(withCookie ? { cookie } : {}) },
}));

describe('POST /api/images', () => {
  it('accepts an image larger than the global body limit and hands Services the exact bytes', async () => {
    const bytes = Buffer.alloc(BODY_LIMIT_BYTES * 2, 7);
    const res = await upload(bytes);
    expect(res.statusCode).toBe(201);
    const [call] = t.services.callsTo('uploadImage');
    expect(call!.args[0]).toBe(OWNER_A);
    expect(Buffer.compare(call!.args[1] as Buffer, bytes)).toBe(0);
  });

  it('refuses a body over the image limit without calling Services', async () => {
    const res = await upload(Buffer.alloc(IMAGE_MAX_BYTES + 1));
    expect(res.statusCode).toBe(413);
    expect(t.services.callsTo('uploadImage')).toEqual([]);
  });

  it('needs a session and an image content type', async () => {
    expect((await upload(Buffer.from([1, 2, 3]), 'image/png', false)).statusCode).toBe(401);
    const html = await upload(Buffer.from('<h1>hi</h1>'), 'text/html');
    expect(html.statusCode).toBe(415);
    expect(json<ApiErrorBody>(html).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(t.services.callsTo('uploadImage')).toEqual([]);
  });
});

describe('GET /api/images/:id', () => {
  it('is a JSON 404 for an unknown or malformed id', async () => {
    for (const id of ['im_0000000000', 'not-an-id']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/images/${id}` });
      expect(res.statusCode, id).toBe(404);
      expect(json<ApiErrorBody>(res).error.code).toBe('NOT_FOUND');
    }
  });
});
