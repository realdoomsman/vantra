import { useState } from 'react';
import { ChartFrame, ChartTip } from './ChartFrame';
import { linear, linePath, markColor, maxOf, nearestIndex, niceTicks, tickLabel, xTickIndices } from './scale';
import type { Series } from './scale';
import { useMeasure } from './useMeasure';
import { fmtDate } from '../../lib/format';

interface LineChartProps {
  /** X labels (ISO dates or timestamps), oldest → newest. */
  x: string[];
  series: Series[];
  height?: number;
  formatValue?: (v: number) => string;
  formatX?: (x: string) => string;
}

const PAD = { top: 10, right: 14, bottom: 22, left: 44 };

/** Multi-series line chart on ONE axis: 2px lines, end markers with a surface ring, crosshair tooltip. */
export function LineChart({ x, series, height = 220, formatValue = tickLabel, formatX = fmtDate }: LineChartProps) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const n = x.length;
  const ticks = niceTicks(maxOf(series.map((s) => s.values)));
  const yMax = ticks[ticks.length - 1] ?? 1;
  const x0 = PAD.left;
  const x1 = Math.max(x0 + 1, width - PAD.right);
  const sx = linear([0, Math.max(1, n - 1)], [x0, x1]);
  const sy = linear([0, yMax], [height - PAD.bottom, PAD.top]);

  const lines = series.map((s) => ({
    ...s,
    points: s.values.map((v, i) => (v === null ? null : { x: sx(i), y: sy(v) })),
  }));

  return (
    <ChartFrame x={x} series={series} formatValue={formatValue} formatX={formatX} swatch="line">
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
          {lines.map((s) => (
            <path key={s.key} d={linePath(s.points)} fill="none" stroke={markColor(s.color)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {lines.map((s) => {
            const last = [...s.points].reverse().find((p) => p !== null);
            return last ? <circle key={s.key} cx={last.x} cy={last.y} r={4} fill={markColor(s.color)} stroke="var(--panel)" strokeWidth={2} /> : null;
          })}
          {hover !== null && (
            <>
              <line className="crosshair" x1={sx(hover)} x2={sx(hover)} y1={PAD.top} y2={height - PAD.bottom} />
              {lines.map((s) => {
                const p = s.points[hover];
                return p ? <circle key={s.key} cx={p.x} cy={p.y} r={4} fill={markColor(s.color)} stroke="var(--panel)" strokeWidth={2} /> : null;
              })}
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
            rows={series.map((s) => {
              const v = s.values[hover];
              return { label: s.label, color: markColor(s.color), value: v === null || v === undefined ? '—' : formatValue(v) };
            })}
          />
        )}
      </div>
    </ChartFrame>
  );
}
