import { linear, linePath, markColor } from './scale';
import type { ChartColor } from './scale';
import { useMeasure } from './useMeasure';

interface SparklineProps {
  /** Oldest → newest. */
  values: number[];
  color?: ChartColor;
  height?: number;
  className?: string;
}

/** Trend line in the de-emphasis ink with the current point in the accent (stat tile contract). */
export function Sparkline({ values, color = 'accent', height = 26, className }: SparklineProps) {
  const [ref, width] = useMeasure<HTMLDivElement>(120);
  if (values.length < 2) return null;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const x = linear([0, values.length - 1], [2, width - 4]);
  const y = linear([min, max === min ? min + 1 : max], [height - 3, 3]);
  const pts = values.map((v, i) => ({ x: x(i), y: y(v) }));
  const last = pts[pts.length - 1]!;

  return (
    <div ref={ref} className={className ? `spark ${className}` : 'spark'} style={{ height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`trend, latest ${values[values.length - 1]}`}>
        <path d={linePath(pts)} fill="none" stroke="var(--dim)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={last.x} cy={last.y} r={3} fill={markColor(color)} stroke="var(--panel)" strokeWidth={2} />
      </svg>
    </div>
  );
}
