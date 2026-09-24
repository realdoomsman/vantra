import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  text?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** Dashed empty/degraded state box (AMENDMENTS D38). */
export function EmptyState({ title, text, children, className }: EmptyStateProps) {
  return (
    <div className={className ? `empty-state ${className}` : 'empty-state'}>
      <div className="es-title">{title}</div>
      {text !== undefined && <div>{text}</div>}
      {children !== undefined && <div className="section-gap">{children}</div>}
    </div>
  );
}
