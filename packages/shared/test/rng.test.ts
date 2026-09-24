import { describe, expect, it } from 'vitest';
import { makeRng, mulberry32 } from '../src/rng.js';

describe('rng', () => {
  it('is deterministic for a seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
  it('keeps helpers in range', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 200; i++) {
      const n = rng.int(1, 6);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
      const s = rng.skew(0.05, 1, 2);
      expect(s).toBeGreaterThanOrEqual(0.05);
      expect(s).toBeLessThan(1);
    }
    expect(['a', 'b']).toContain(rng.pick(['a', 'b']));
    expect(() => rng.pick([])).toThrow();
  });
});
