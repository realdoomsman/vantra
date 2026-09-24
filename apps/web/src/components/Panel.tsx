import type { ReactNode } from 'react';

interface PanelProps {
  title: ReactNode;
  right?: ReactNode;
  /** Remove body padding (tables, feeds). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Panel({ title, right, flush, className, bodyClassName, children }: PanelProps) {
  return (
    <section className={className ? `panel ${className}` : 'panel'}>
      <div className="panel-head">
        <span>{title}</span>
        <span className="dots" />
        {right !== undefined && <span className="right">{right}</span>}
      </div>
      <div className={['panel-body', flush ? 'flush' : '', bodyClassName ?? ''].filter(Boolean).join(' ')}>{children}</div>
    </section>
  );
}
