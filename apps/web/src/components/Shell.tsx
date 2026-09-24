import { useEffect, useState, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { PROTOCOL_DISCLAIMER } from '@vantra/shared';
import { Ticker } from './Ticker';
import { TopNav } from './TopNav';
import { useAppStore } from '../store/app';

/**
 * Sticky top nav + ticker (which carries the mode notice) + page + footer, under the tube.
 *
 * `.crt` is the one scanline layer for the whole viewport and is a SIBLING of `.app`, not a child:
 * `.app` is a stacking context at `z-index: 2`, so a nested overlay would be trapped inside it and
 * sit above the page content instead of behind it.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="crt" aria-hidden="true" />
      <div className="app">
        <TopNav />
        <Ticker />
        <main className="main">
          <div className="wrap">{children}</div>
        </main>
        <ShellFoot />
      </div>
    </>
  );
}

/**
 * What the rail's foot used to carry: the one sentence a buyer has to read before spending, and
 * the connection readout that says whether anything above it is still current. The mode notice is
 * not repeated here — the ticker already states it at the top of every page.
 */
function ShellFoot() {
  const stats = useAppStore((s) => s.stats);
  const wsState = useAppStore((s) => s.wsState);
  const lastSyncAt = useAppStore((s) => s.lastSyncAt);
  const version = useAppStore((s) => s.version);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const synced = lastSyncAt === null ? '—' : `${Math.max(0, Math.round((now - lastSyncAt) / 1000))}s ago`;
  const cluster = stats ? (stats.chain.mode === 'memory' ? 'memory' : stats.chain.cluster) : '…';

  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-in">
          <span className="foot-word">VANTRA</span>
          <span className="foot-note">
            One agent, paid by the trading fees of its own token. When the money runs out it dies — most do.
            Buying your own buys it compute, not a return.
          </span>
          <span className="foot-status mono-num" title={PROTOCOL_DISCLAIMER}>
            WS {wsState === 'open' ? '●' : '○'} · synced {synced} · v{version ?? '?'} · {cluster}
            <span className="cur" aria-hidden="true" />
          </span>
        </div>
      </div>
    </footer>
  );
}

/** Route layout: everything except the full-screen control board renders inside the Shell. */
export function ShellLayout() {
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
