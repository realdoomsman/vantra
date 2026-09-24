import type { ReactNode } from 'react';
import { Sparkline } from './charts/Sparkline';
import type { ChartColor } from './charts/scale';

interface StatTileProps {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: 'pos' | 'neg' | 'warn';
  /** Sparkline points (oldest → newest); rendered in .stat-trend when ≥ 2. */
  trend?: number[];
  trendColor?: ChartColor;
  small?: boolean;
  className?: string;
}

export function StatTile({ label, value, delta, deltaTone, trend, trendColor = 'accent', small, className }: StatTileProps) {
  return (
    <div className={className ? `stat-tile ${className}` : 'stat-tile'}>
      <div className="stat-label">{label}</div>
      <div className={small ? 'stat-value sm' : 'stat-value'}>{value}</div>
      {delta !== undefined && <div className={deltaTone ? `stat-delta ${deltaTone}` : 'stat-delta'}>{delta}</div>}
      {trend && trend.length >= 2 && (
        <div className="stat-trend">
          <Sparkline values={trend} color={trendColor} />
        </div>
      )}
    </div>
  );
}
