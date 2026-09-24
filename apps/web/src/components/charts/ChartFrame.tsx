import { useState } from 'react';
import type { ReactNode } from 'react';
import { EmptyState } from '../EmptyState';
import { markColor } from './scale';
import type { Series } from './scale';

interface ChartFrameProps {
  x: string[];
  series: Series[];
  formatValue: (v: number) => string;
  formatX: (x: string) => string;
  /** Legend swatch shape: line for line charts, rect for areas/bars. */
  swatch: 'line' | 'rect';
  /** The SVG plot; receives nothing, the parent already closed over its data. */
  children: ReactNode;
}

/**
 * Shared chrome around every SVG chart: the table-view toggle
 * (.chart-alt-toggle), legend for ≥ 2 series, and the <2-point empty state.
 */
export function ChartFrame({ x, series, formatValue, formatX, swatch, children }: ChartFrameProps) {
  const [table, setTable] = useState(false);
  if (x.length < 2) return <EmptyState title="NOT ENOUGH DATA" text="Charts appear once two days of history exist." />;

  return (
    <div className="chart-box">
      <button type="button" className="chart-alt-toggle" onClick={() => setTable((t) => !t)} aria-pressed={table}>
        {table ? 'chart' : 'table'}
      </button>
      {series.length >= 2 && (
        <div className="chart-legend">
          {series.map((s) => (
            <span className="key" key={s.key}>
              <i style={{ background: markColor(s.color), height: swatch === 'rect' ? 8 : 2 }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      {table ? (
        <div className="chart-table tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>date</th>
                {series.map((s) => (
                  <th className="num" key={s.key}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {x.map((d, i) => (
                <tr key={d}>
                  <td>{formatX(d)}</td>
                  {series.map((s) => {
                    const v = s.values[i];
                    return <td className="num" key={s.key}>{v === null || v === undefined ? '—' : formatValue(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

interface TipProps {
  left: number;
  width: number;
  date: string;
  rows: { label: string; color: string; value: string }[];
}

/** Tooltip listing every series at the hovered x; flips left near the right edge. */
export function ChartTip({ left, width, date, rows }: TipProps) {
  const flip = left > width * 0.62;
  return (
    <div className="chart-tip" style={{ top: 8, left: flip ? undefined : left + 12, right: flip ? width - left + 12 : undefined }}>
      <div className="tt-date">{date}</div>
      {rows.map((r) => (
        <div className="tt-row" key={r.label}>
          <span className="n">
            <i style={{ background: r.color }} />
            {r.label}
          </span>
          <span className="v">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
