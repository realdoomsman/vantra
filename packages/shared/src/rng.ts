// Deterministic PRNG (mulberry32). The demo colony boots identically from the same seed.

export type Rng = {
  next(): number;                                       // [0, 1)
  range(min: number, max: number): number;              // float in [min, max)
  int(min: number, max: number): number;                // integer in [min, max]
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  // Skewed toward low values; exponent > 1 pushes mass down. Used for competence so
  // most agents are mediocre and a few are exceptional.
  skew(min: number, max: number, exp?: number): number;
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: <T>(arr: readonly T[]): T => {
      if (arr.length === 0) throw new Error('pick() on empty array');
      return arr[Math.floor(next() * arr.length)] as T;
    },
    skew: (min, max, exp = 2) => min + Math.pow(next(), exp) * (max - min),
  };
}
