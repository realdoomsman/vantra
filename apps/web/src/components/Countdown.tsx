import { useEffect, useState } from 'react';
import { fmtCountdown, fmtUntil } from '../lib/format';

interface CountdownProps {
  /** ISO timestamp; null renders '--:--'. */
  to: string | null;
  className?: string;
}

/** mm:ss until `to`, ticking every second and clamping at 00:00. */
export function Countdown({ to, className }: CountdownProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!to) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [to]);

  return <span className={className ? `mono-num ${className}` : 'mono-num'}>{to ? fmtCountdown(to, now) : '--:--'}</span>;
}

/**
 * The same clock at a coarser scale, for the deposit window (SPEC-V2 §9.5, §9.8): a 72-hour expiry
 * has to read '2d 23h', not '4319:58'. Ticks once a second under an hour and once a minute above it.
 */
export function ExpiryCountdown({ to, className }: CountdownProps) {
  const [now, setNow] = useState(() => Date.now());
  const soon = to !== null && Date.parse(to) - now < 3_600_000;

  useEffect(() => {
    if (!to) return;
    const id = setInterval(() => setNow(Date.now()), soon ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [to, soon]);

  return <span className={className ? `mono-num ${className}` : 'mono-num'}>{to ? fmtUntil(to, now) : '—'}</span>;
}
