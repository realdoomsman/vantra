export interface NavItem {
  label: string;
  to: string;
  end?: boolean;
}

/**
 * The shell links, in bar order. LAUNCHPAD is home: the directory of launched coins is what this
 * site is now about. `end` keeps it from lighting up on every route, since every path starts `/`.
 *
 * Launching and buying are actions, not places, so neither is here: LAUNCH is the primary button
 * and BUY the secondary outline button in `.nav-right` (and in the drawer). `/mine` is reached
 * through the wallet menu.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'LAUNCHPAD', to: '/', end: true },
  { label: 'OBSERVATORY', to: '/observatory' },
  { label: 'AGENTS', to: '/agents' },
  { label: 'MARKET', to: '/market' },
  { label: 'GRAVEYARD', to: '/graveyard' },
  { label: 'PROTOCOL', to: '/protocol' },
];
