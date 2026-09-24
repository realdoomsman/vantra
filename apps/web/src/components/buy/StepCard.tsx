import type { ReactNode } from 'react';

interface StepCardProps {
  num: number;
  title: string;
  /** Right-hand marker: 'READY', 'OK', 'LOCKED'… */
  done?: ReactNode;
  /** Dim + non-interactive. */
  locked?: boolean;
  children: ReactNode;
}

/** One `.spawn-step` card — the v1 step shell, reused unchanged by the buy flow. */
export function StepCard({ num, title, done, locked, children }: StepCardProps) {
  return (
    <section className={locked ? 'spawn-step locked' : 'spawn-step'} aria-disabled={locked || undefined}>
      <div className="spawn-step-head">
        <span className="spawn-step-num">{num}</span>
        <span className="t">{title}</span>
        {done !== undefined && <span className="done">{done}</span>}
      </div>
      <div className="spawn-step-body">{children}</div>
    </section>
  );
}
