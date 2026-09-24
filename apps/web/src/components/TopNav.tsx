import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { fmtUsd } from '@vantra/shared';
import { NAV_ITEMS } from './nav';
import { WalletButton } from './WalletButton';
import { useAppStore } from '../store/app';

/**
 * The breakpoint `.nav-burger` / `.nav-drawer` live below; global.css owns the number and this
 * mirrors it. It is the nav's own query, not the 900px layout one: six links, two buttons and the
 * wallet button stop fitting in the bar long before the content grid needs to reflow.
 *
 * The stylesheet collapses at `max-width: 1100px`, which includes exactly 1100, so this is the
 * complement rather than `min-width: 1100px` — otherwise both halves match at that one width and
 * the LAUNCH and BUY buttons render in the bar and in the open drawer at the same time.
 */
const DRAWER_MQ = '(min-width: 1100.02px)';

/**
 * The whole shell header: brand, the links, the live global numbers + wallet, and below 1100px a
 * burger that opens `.nav-drawer` with the links and the numbers the narrow bar drops. LAUNCH is
 * the one primary button on the bar; BUY sits beside it as an outline. What is simulated about
 * this run is stated by the notice at the right end of the ticker directly below.
 */
export function TopNav() {
  const [open, setOpen] = useState(false);
  const wideBar = useWideBar();
  const { pathname } = useLocation();

  // A nav link is the only thing in the drawer that navigates, so closing on pathname also covers
  // the back button and any programmatic redirect that fires while the panel is open.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape closes it, and so does growing past the breakpoint: above 900px the burger itself is
  // gone, so an open panel would otherwise have no control left that can dismiss it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const mq = window.matchMedia(DRAWER_MQ);
    const onWide = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    mq.addEventListener('change', onWide);
    return () => {
      window.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onWide);
    };
  }, [open]);

  return (
    <header className="nav">
      <div className="nav-in">
        <Link className="brand" to="/">
          <BrandMark />
          <span className="brand-word">VANTRA</span>
        </Link>
        <nav className="nav-links">
          <NavLinks />
        </nav>
        <div className="nav-right">
          <NavStats />
          {wideBar && <ActionButtons />}
          <WalletButton />
        </div>
        <button
          type="button"
          className={open ? 'nav-burger is-open' : 'nav-burger'}
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="nav-drawer"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="nav-burger-bar" />
          <span className="nav-burger-bar" />
          <span className="nav-burger-bar" />
        </button>
      </div>
      {open && (
        <div className="nav-drawer" id="nav-drawer">
          <nav className="nav-drawer-links">
            <NavLinks />
            <div className="nav-drawer-actions">
              <ActionButtons />
            </div>
          </nav>
          <div className="nav-drawer-stats">
            <NavStats />
          </div>
        </div>
      )}
    </header>
  );
}

/** The shell links, in order, rendered identically in the bar and in the drawer. */
function NavLinks() {
  return (
    <>
      {NAV_ITEMS.map((it) => (
        <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => (isActive ? 'nav-link is-active' : 'nav-link')}>
          {it.label}
        </NavLink>
      ))}
    </>
  );
}

/**
 * LAUNCH is the point of the site, so it is the one molten button in the shell; buying an agent
 * outright is the secondary path, an outline beside it. They render once — in the bar above the
 * drawer breakpoint, in the drawer below it — because the narrow bar has no room to spare and a
 * second copy would push the burger off screen.
 */
function ActionButtons() {
  return (
    <>
      <Link className="btn-primary" to="/launch" title="Launch a coin that pays an AI agent">
        LAUNCH
      </Link>
      <Link className="btn-ghost" to="/buy" title="Buy your own agent">
        BUY
      </Link>
    </>
  );
}

/** True above the `.nav-burger` / `.nav-drawer` breakpoint, i.e. when the full bar is showing. */
function useWideBar(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(DRAWER_MQ).matches);

  useEffect(() => {
    const mq = window.matchMedia(DRAWER_MQ);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return wide;
}

/** Colony heartbeat. `.optional` is the pair the bar drops first when it runs out of width. */
function NavStats() {
  const stats = useAppStore((s) => s.stats);
  const treasury = useAppStore((s) => s.treasury);

  return (
    <>
      <span className="kv">
        <span className="k">TREASURY</span>
        <span className="v mono-num">{treasury ? fmtUsd(treasury.usdcMicro) : '—'}</span>
      </span>
      <span className="kv">
        <span className="k">ALIVE</span>
        <span className="v mono-num pos">{stats?.alive ?? '—'}</span>
      </span>
      <span className="kv optional">
        <span className="k">DEAD</span>
        <span className="v mono-num">{stats?.dead ?? '—'}</span>
      </span>
      <span className="kv optional">
        <span className="k">EXT REV</span>
        <span className="v mono-num">{stats ? fmtUsd(stats.revenueExternalMicro) : '—'}</span>
      </span>
    </>
  );
}

/**
 * The VANTRA burn-down: six bars narrowing downward, bone at the top through molten to ember at
 * the tip — the colony spending itself down. Fills are explicit palette variables, not
 * `currentColor`, so the mark keeps its ramp wherever the surrounding text colour lands.
 */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 100 100" aria-hidden focusable="false">
      <rect x="9" y="10" width="82" height="10.2" fill="var(--bone)" />
      <rect x="15.6" y="23.8" width="68.8" height="10.2" fill="var(--dim)" />
      <rect x="22.2" y="37.6" width="55.6" height="10.2" fill="var(--dim)" />
      <rect x="28.8" y="51.4" width="42.4" height="10.2" fill="var(--molten)" />
      <rect x="35.4" y="65.2" width="29.2" height="10.2" fill="var(--molten)" />
      <rect x="42" y="79" width="16" height="10.2" fill="var(--ember)" />
    </svg>
  );
}
