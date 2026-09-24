import { describe, expect, it } from 'vitest';
import { NAME_RE } from '../src/constants.js';
import { slugify, validateName } from '../src/names.js';

describe('validateName', () => {
  it('accepts and uppercases valid names', () => {
    expect(validateName('  atlas-7 ')).toEqual({ ok: true, name: 'ATLAS-7' });
    expect(validateName('A1B')).toEqual({ ok: true, name: 'A1B' });
    expect(validateName('SIXTEEN-CHARS-OK')).toEqual({ ok: true, name: 'SIXTEEN-CHARS-OK' });
  });
  it('rejects bad shapes', () => {
    for (const bad of ['AB', '-ABC', 'A B', 'SEVENTEEN-CHARS-X', 'nice_one', '']) {
      expect(validateName(bad).ok, bad).toBe(false);
    }
  });
  // Leading, trailing and doubled dashes are what used to make two legal names share one slug.
  it('rejects leading, trailing and doubled dashes', () => {
    for (const bad of ['X--Y', 'ATLAS-', '-ATLAS', 'A--', 'A-', 'A--B--C']) {
      expect(validateName(bad).ok, bad).toBe(false);
    }
  });
  it('counts characters, not alphanumerics, for the 3-16 rule', () => {
    expect(NAME_RE.test('A-B-C-D-E-F-G-H-I-J-K-L-M-N-O-P')).toBe(false);   // 31 chars
    expect(validateName('A-B-C-D-E-F-G-H').ok).toBe(true);                  // 15 chars
  });
  it('rejects reserved words', () => {
    for (const r of ['vantra', 'POOL', 'Admin', 'SYSTEM']) {
      const v = validateName(r);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/reserved/);
    }
  });
});

describe('slugify', () => {
  it('lowercases valid names into url-safe slugs', () => {
    expect(slugify('ATLAS-7')).toBe('atlas-7');
    expect(slugify('X-Y')).toBe('x-y');
  });

  // agents.deploy_slug is UNIQUE, so two names that validate must never produce one slug.
  it('is injective over every name validateName accepts', () => {
    const alphabet = ['A', 'B', '1', '-'];
    const seen = new Map<string, string>();
    const build = (prefix: string): void => {
      if (prefix.length > 5) return;
      const checked = validateName(prefix);
      if (checked.ok) {
        const slug = slugify(checked.name);
        const clash = seen.get(slug);
        expect(clash, `${clash} and ${checked.name} both slugify to ${slug}`).toBeUndefined();
        seen.set(slug, checked.name);
      }
      for (const c of alphabet) build(prefix + c);
    };
    build('');
    expect(seen.size).toBeGreaterThan(50);
  });
});
