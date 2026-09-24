// Shared chart math: token colours, nice ticks, linear scales, path builders.

// Series roles, not hues: the stylesheet decides what each one looks like.
// accent = the primary series, neutral = its counterpart, pos/neg/warn = signed data.
export type ChartColor = 'accent' | 'neutral' | 'pos' | 'neg' | 'warn';

/** Series colours come from the design tokens validated for the dark surface. */
export const markColor = (c: ChartColor): string => `var(--mk-${c})`;

export interface Series {
  key: string;
  label: string;
  color: ChartColor;
  /** One value per x; null = gap. */
  values: (number | null)[];
}

export interface Scale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const fn = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  fn.domain = domain;
  fn.range = range;
  return fn;
}

/** Clean tick values 0 … ≥max (round steps: 1, 2, 2.5, 5 × 10^n). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

export function maxOf(values: (number | null)[][]): number {
  let m = 0;
  for (const row of values) for (const v of row) if (v !== null && v > m) m = v;
  return m;
}

/** SVG path for a polyline with gaps at nulls. */
export function linePath(points: ({ x: number; y: number } | null)[]): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Closed area between an upper and lower polyline (no gaps). */
export function areaPath(upper: { x: number; y: number }[], lower: { x: number; y: number }[]): string {
  if (upper.length === 0) return '';
  const up = upper.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
  const down = [...lower].reverse().map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');
  return `${up}${down}Z`;
}

/** Index of the x-slot nearest to a pixel position. */
export function nearestIndex(px: number, x0: number, x1: number, n: number): number {
  if (n <= 1) return 0;
  const t = (px - x0) / (x1 - x0);
  return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
}

/** Compact axis tick label: 1.2K / 4M / 0.5. */
export function tickLabel(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${trimZeros((v / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${trimZeros((v / 1_000).toFixed(1))}K`;
  return trimZeros(v.toFixed(abs < 1 && abs > 0 ? 2 : 0));
}

const trimZeros = (s: string): string => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

/** Pick ≤ `count` evenly spaced x indices for axis labels, always including first and last. */
export function xTickIndices(n: number, count = 5): number[] {
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < count; i++) out.add(Math.round((i * (n - 1)) / (count - 1)));
  return [...out].sort((a, b) => a - b);
}
