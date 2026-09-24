// Agent naming rules: uppercase alnum + dash, 3–16 chars, not a reserved word (SPEC §8.4).
import { NAME_RE, RESERVED_NAMES } from './constants.js';


export type NameValidation = { ok: true; name: string } | { ok: false; reason: string };

export function validateName(raw: string): NameValidation {
  const name = raw.trim().toUpperCase();
  if (!NAME_RE.test(name)) {
    return { ok: false, reason: 'Name must be 3–16 characters: A–Z, 0–9 and dashes, starting with a letter or digit' };
  }
  if (RESERVED_NAMES.includes(name)) {
    return { ok: false, reason: `"${name}" is reserved` };
  }
  return { ok: true, name };
}

// deploySlug for /sites/:slug. Precondition: `name` has passed validateName, whose alphabet
// ([A-Z0-9] with single interior dashes) is already URL-safe. Lowercasing is therefore lossless and
// injective — collapsing or stripping dashes here would map two legal names onto one slug and break
// the UNIQUE agents.deploy_slug (SPEC §7).
export function slugify(name: string): string {
  return name.toLowerCase();
}
