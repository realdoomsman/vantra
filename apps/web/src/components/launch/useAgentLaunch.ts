// The launch behind an agent, kept current on the profile's live cadence.
//
// The profile is driven by WS: 'agent' patches and the per-agent live ring. The lifecycle job
// announces everything a launch panel shows through those — activation ('activate' event + a status
// patch), rung-ups ('milestone'), buyback-and-burn ('burn' event + the buyback ledger row) and going
// broke ('sleep') — so each of those, and any change to the patched status/treasury/model/claimed
// fees, re-reads the launch. The one number no WS message carries is the escrow balance: a dormant
// AI runs no steps, so a coin being traded while it sleeps would otherwise sit frozen on screen. A
// slow re-read (the landing page's flagship cadence) covers that.
//
// A bought agent answers 404 once and is never read again, so its profile costs one request.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentPublic, EventKind, LaunchDetail } from '@vantra/shared';
import { api, isApiError } from '../../api/client';
import { useAgentLive } from '../../store/feed';

const REFRESH_MS = 30_000;
const LAUNCH_EVENTS: Partial<Record<EventKind, true>> = { launch: true, activate: true, burn: true, milestone: true, sleep: true };

export interface AgentLaunch {
  /** undefined until the first read answers; null when the agent was bought, not launched. */
  launch: LaunchDetail | null | undefined;
  /** The last read failed; the panel keeps showing the previous launch. */
  error: string | null;
  reload: () => Promise<void>;
}

type LiveFields = Pick<AgentPublic, 'status' | 'treasuryMicro' | 'model' | 'creatorRewardMicro'>;

export function useAgentLaunch(agentId: string, agent: LiveFields | null): AgentLaunch {
  const [launch, setLaunch] = useState<LaunchDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Reads can overlap (a WS burst, the poll, an action); only the newest one may land.
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api.agentLaunch(agentId);
      if (mine !== seq.current) return;
      setLaunch(next);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(isApiError(e) ? e.message : 'Could not load this coin');
    }
  }, [agentId]);

  useEffect(() => {
    setLaunch(undefined);
    setError(null);
    void reload();
  }, [reload]);

  const live = useAgentLive(agentId);
  const lastLaunchItem = useMemo(() => {
    for (const item of live) {
      if (item.kind === 'event' && LAUNCH_EVENTS[item.event.kind]) return item.id;
      if (item.kind === 'ledger' && item.entry.kind === 'buyback') return item.id;
    }
    return null;
  }, [live]);
  const signature = agent ? `${agent.status}|${agent.treasuryMicro}|${agent.model}|${agent.creatorRewardMicro}|${lastLaunchItem ?? ''}` : '';

  const launched = Boolean(launch);
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;
    if (launched) void reload();
  }, [signature, launched, reload]);

  useEffect(() => {
    if (!launched) return;
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [launched, reload]);

  return { launch, error, reload };
}
