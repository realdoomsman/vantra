import { useEffect, useId, useRef, useState } from 'react';
import { modeInfo } from '../lib/mode';
import { useAppStore } from '../store/app';

/**
 * `auto` shows the details on hover/focus only; `open` pins them (a tap or click); `closed`
 * suppresses even the hover/focus view until the pointer or focus leaves, so Escape dismisses
 * them without moving focus.
 */
type View = 'auto' | 'open' | 'closed';

/**
 * The mode notice (D29), riding the right end of the ticker instead of taking a full-width bar of
 * its own. The chip always names every part of the run that is not real — seeded colony, simulated
 * chain, test USDC, mock brains — and the full sentence for each is one hover, tap or Tab away. The
 * sentences are also the button's accessible description, so a screen reader hears all of it
 * without opening anything. Hidden only when money, brains and the colony are all real; the copy
 * itself is composed in `lib/mode.ts`.
 */
export function EnvBanner() {
  const stats = useAppStore((s) => s.stats);
  const { label, notice } = modeInfo(stats);
  const [view, setView] = useState<View>('auto');
  const ref = useRef<HTMLDivElement>(null);
  const popId = useId();

  // Escape dismisses whatever is showing; a tap anywhere else unpins it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setView('auto');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ref.current?.matches(':hover, :focus-within, .is-open')) setView('closed');
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (notice.length === 0) return null;

  return (
    <div
      className={view === 'auto' ? 'env-notice' : `env-notice is-${view}`}
      ref={ref}
      onPointerLeave={() => setView((v) => (v === 'closed' ? 'auto' : v))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setView((v) => (v === 'closed' ? 'auto' : v));
      }}
    >
      <button
        type="button"
        className="env-notice-btn"
        aria-expanded={view === 'open'}
        aria-controls={popId}
        aria-describedby={popId}
        onClick={() => setView((v) => (v === 'open' ? 'closed' : 'open'))}
      >
        <b>{label}</b>
        {notice.map((n) => (
          <span key={n.name} className="env-notice-name">
            {n.name}
          </span>
        ))}
      </button>
      <ul className="env-notice-pop" id={popId}>
        {notice.map((n) => (
          <li key={n.name}>
            <b>{n.name}</b>
            <span>{n.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
