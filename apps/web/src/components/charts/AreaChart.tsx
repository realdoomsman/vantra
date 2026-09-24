import { useState } from 'react';
import { ChartFrame, ChartTip } from './ChartFrame';
import { areaPath, linear, linePath, markColor, nearestIndex, niceTicks, tickLabel, xTickIndices } from './scale';
import type { Series } from './scale';
import { useMeasure } from './useMeasure';
import { fmtDate } from '../../lib/format';

interface AreaChartProps {
  x: string[];
  /** Stacked bottom → top. Nulls are treated as 0 for stacking. */
  series: Series[];
  height?: number;
  formatValue?: (v: number) => string;
  formatX?: (x: string) => string;
}

const PAD = { top: 10, right: 14, bottom: 22, left: 44 };

/** Stacked area: ~10% washes with a 2px band-edge line per series, crosshair tooltip with per-series values. */
export function AreaChart({ x, series, height = 220, formatValue = tickLabel, formatX = fmtDate }: AreaChartProps) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const n = x.length;
  const stacked: number[][] = [];
  let prev: number[] = Array.from({ length: n }, () => 0);
  for (const s of series) {
    const top = prev.map((base, i) => base + (s.values[i] ?? 0));
    stacked.push(top);
    prev = top;
  }
  const ticks = niceTicks(Math.max(0, ...prev));
  const yMax = ticks[ticks.length - 1] ?? 1;
  const x0 = PAD.left;
  const x1 = Math.max(x0 + 1, width - PAD.right);
  const sx = linear([0, Math.max(1, n - 1)], [x0, x1]);
  const sy = linear([0, yMax], [height - PAD.bottom, PAD.top]);
  const toPts = (row: number[]) => row.map((v, i) => ({ x: sx(i), y: sy(v) }));
  const baseline = toPts(Array.from({ length: n }, () => 0));

  return (
    <ChartFrame x={x} series={series} formatValue={formatValue} formatX={formatX} swatch="rect">
      <div ref={ref} style={{ position: 'relative' }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={series.map((s) => s.label).join(', ')}>
          <g className="grid">
            {ticks.map((t) => (
              <line key={t} x1={x0} x2={x1} y1={sy(t)} y2={sy(t)} />
            ))}
          </g>
          <g className="axis">
            {ticks.map((t) => (
              <text key={t} x={x0 - 6} y={sy(t) + 3} textAnchor="end">{formatValue(t)}</text>
            ))}
            {xTickIndices(n).map((i) => (
              <text key={i} x={sx(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{formatX(x[i]!)}</text>
            ))}
          </g>
          {series.map((s, k) => {
            const upper = toPts(stacked[k]!);
            const lower = k === 0 ? baseline : toPts(stacked[k - 1]!);
            return (
              <g key={s.key}>
                <path d={areaPath(upper, lower)} fill={markColor(s.color)} fillOpacity={0.12} />
                <path d={linePath(upper)} fill="none" stroke={markColor(s.color)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {hover !== null && (
            <>
              <line className="crosshair" x1={sx(hover)} x2={sx(hover)} y1={PAD.top} y2={height - PAD.bottom} />
              {series.map((s, k) => (
                <circle key={s.key} cx={sx(hover)} cy={sy(stacked[k]![hover]!)} r={4} fill={markColor(s.color)} stroke="var(--panel)" strokeWidth={2} />
              ))}
            </>
          )}
          <rect
            className="hit"
            x={x0}
            y={0}
            width={x1 - x0}
            height={height}
            onPointerMove={(e) => setHover(nearestIndex(e.nativeEvent.offsetX, x0, x1, n))}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover !== null && (
          <ChartTip
            left={sx(hover)}
            width={width}
            date={formatX(x[hover]!)}
            rows={series.map((s) => ({ label: s.label, color: markColor(s.color), value: formatValue(s.values[hover] ?? 0) }))}
          />
        )}
      </div>
    </ChartFrame>
  );
}
