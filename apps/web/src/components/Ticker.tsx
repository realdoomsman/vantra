import { Link } from 'react-router-dom';
import type { FeedEvent } from '@vantra/shared';
import { EnvBanner } from './EnvBanner';
import { fmtSigned } from './Money';
import { modeInfo } from '../lib/mode';
import { useAppStore } from '../store/app';
import { useFeedStore } from '../store/feed';

const TICKER_ITEMS = 30;

/**
 * Marquee of the latest 30 events, duplicated once for a seamless loop (D32).
 *
 * `.ticker` is the clip and `.ticker-track` is the single strip that slides inside it, so the
 * live/reconnecting label rides over the left edge of the clip and the mode notice over the right,
 * rather than sitting in the flow — a flow sibling would have to be cut out of the track's travel.
 * The notice lives here, not in a bar of its own, so the page starts two bars down instead of three.
 */
export function Ticker() {
  const stats = useAppStore((s) => s.stats);
  const wsState = useAppStore((s) => s.wsState);
  const events = useFeedStore((s) => s.events);
  const items = events.slice(0, TICKER_ITEMS);
  const off = wsState !== 'open';

  return (
    <div className="ticker">
      <div className={off ? 'ticker-label off' : 'ticker-label'}>
        <span className="pulse-dot" />
        {off ? 'RECONNECTING' : modeInfo(stats).tickerLabel}
      </div>
      <div className="ticker-track" aria-live="off">
        {items.map((e) => (
          <TickerItem key={`a-${e.id}`} event={e} />
        ))}
        {items.map((e) => (
          <TickerItem key={`b-${e.id}`} event={e} duplicate />
        ))}
      </div>
      <EnvBanner />
    </div>
  );
}

/**
 * The seamless loop (D32) is the same 30 events rendered twice. The duplicate is hidden from
 * assistive tech, so its links must be out of the tab order too — otherwise a keyboard user tabs
 * through 30 anchors that are invisible to their screen reader and keep sliding out from under them.
 */
function TickerItem({ event: e, duplicate }: { event: FeedEvent; duplicate?: boolean }) {
  const text = e.agentName && e.text.startsWith(e.agentName) ? e.text.slice(e.agentName.length).trim() : e.text;
  return (
    <span className={e.kind === 'death' ? 't-item t-death' : 't-item'} aria-hidden={duplicate}>
      {e.agentId && e.agentName && (
        <Link to={`/a/${e.agentId}`} tabIndex={duplicate ? -1 : undefined}>
          {e.agentName}
        </Link>
      )}
      {text}
      {e.amountMicro !== null && e.amountMicro !== 0 && <span className={`t-amt ${e.amountMicro > 0 ? 'pos' : 'neg'}`}>{fmtSigned(e.amountMicro)}</span>}
    </span>
  );
}
