import { fmtUsd } from '@vantra/shared';
import type { Micro } from '@vantra/shared';

interface MoneyProps {
  micro: Micro;
  /** Prefix '+' / '−' by sign. */
  signed?: boolean;
  /** Apply .pos/.neg by sign (default true when signed). */
  colored?: boolean;
  className?: string;
}

/** Formatted micro-dollar amount with tabular figures. */
export function Money({ micro, signed = false, colored = signed, className }: MoneyProps) {
  const text = fmtSigned(micro, signed);
  const tone = colored ? (micro > 0 ? 'pos' : micro < 0 ? 'neg' : '') : '';
  return <span className={['mono-num', tone, className ?? ''].filter(Boolean).join(' ')}>{text}</span>;
}

/** '+$1.20' / '-$0.35' / '$0.00' via the shared formatter's sign option. */
export function fmtSigned(micro: Micro, signed = true): string {
  return fmtUsd(micro, { sign: signed });
}
