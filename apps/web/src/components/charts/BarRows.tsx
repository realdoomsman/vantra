import { EmptyState } from '../EmptyState';
import { markColor } from './scale';
import type { ChartColor } from './scale';

export interface BarSegment {
  value: number;
  color: ChartColor;
  /** Segment name shown in the hover title (defaults to the row label). */
  label?: string;
}

export interface BarRow {
  key: string;
  label: string;
  /** Left → right; a single segment for a plain bar. */
  segments: BarSegment[];
  /** Right-hand value text (direct label). */
  valueText: string;
}

interface BarRowsProps {
  rows: BarRow[];
  /** Scale bars against this total instead of the largest row. */
  max?: number;
  formatValue?: (v: number) => string;
  emptyTitle?: string;
}

const GAP_PX = 2;

/** Horizontal bar rows (.hbar-row) with 2px surface gaps between stacked segments. */
export function BarRows({ rows, max, formatValue = String, emptyTitle = 'NOT ENOUGH DATA' }: BarRowsProps) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} />;
  const total = (r: BarRow) => r.segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const scale = Math.max(max ?? 0, ...rows.map(total)) || 1;

  return (
    <div>
      {rows.map((r) => {
        let offset = 0;
        return (
          <div className="hbar-row" key={r.key}>
            <div className="hbar-label" title={r.label}>{r.label}</div>
            <div className="hbar-track">
              {r.segments.map((s, i) => {
                const w = (Math.max(0, s.value) / scale) * 100;
                const left = offset;
                offset += w;
                if (w <= 0) return null;
                return (
                  <div
                    key={i}
                    className="hbar-fill"
                    title={`${s.label ?? r.label}: ${formatValue(s.value)}`}
                    style={{
                      position: 'absolute',
                      left: `calc(${left}% + ${i === 0 ? 0 : GAP_PX}px)`,
                      width: `max(2px, calc(${w}% - ${i === 0 ? 0 : GAP_PX}px))`,
                      background: markColor(s.color),
                      borderRadius: i === r.segments.length - 1 ? '0 4px 4px 0' : 0,
                    }}
                  />
                );
              })}
            </div>
            <div className="hbar-val">{r.valueText}</div>
          </div>
        );
      })}
    </div>
  );
}
