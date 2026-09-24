import type { AgentStatus } from '@vantra/shared';

const LIGHTS = 12;
const DAYS_PER_LIGHT = 2.5;

interface RunwayStripProps {
  runwayDays: number | null;
  status: AgentStatus;
  size?: 'sm' | 'lg';
  /** Used for the "DIED D+{age}" label on dead agents. */
  ageDays?: number;
  className?: string;
}

/* Tones name the STATE, not a colour: the strip is a fuel gauge, and in this
   palette a hot light means the money is nearly gone, not that things are fine. */
export type RunwayTone = 'ok' | 'low' | 'critical';

/** >14d ok, 3–14d low, <3d critical (D31). */
export function runwayTone(runwayDays: number | null): RunwayTone {
  if (runwayDays === null || runwayDays > 14) return 'ok';
  if (runwayDays >= 3) return 'low';
  return 'critical';
}

/**
 * 12 lights × 2.5 days; exact contract from AMENDMENTS D31. A dormant launched AI has no money and no
 * burn, so `runwayDays` is null — which would otherwise read as a full, calm, infinite tank. It is
 * the opposite: every light off, labelled DORMANT, until its coin's fees wake it.
 */
export function RunwayStrip({ runwayDays, status, size, ageDays, className }: RunwayStripProps) {
  const cls = ['rw-strip', size ?? '', className ?? ''].filter(Boolean).join(' ');
  const dead = status === 'dead';
  const dormant = status === 'dormant';
  const lit = dormant ? 0 : dead ? LIGHTS : runwayDays === null ? LIGHTS : Math.min(LIGHTS, Math.max(1, Math.ceil(runwayDays / DAYS_PER_LIGHT)));
  const lightClass = dead ? 'end-dead' : `on-${runwayTone(runwayDays)}`;

  return (
    <span className={cls}>
      <span className="rw-lights">
        {Array.from({ length: LIGHTS }, (_, i) => (
          <i key={i} className={i < lit ? lightClass : undefined} />
        ))}
      </span>
      <span className={dormant ? 'rw-days dormant' : 'rw-days'}>
        {dormant ? (
          'DORMANT'
        ) : dead ? (
          `DIED D+${Math.max(0, Math.floor(ageDays ?? 0))}`
        ) : runwayDays === null ? (
          '∞'
        ) : (
          <>
            <b>{runwayDays.toFixed(1)}</b>d
          </>
        )}
      </span>
    </span>
  );
}
