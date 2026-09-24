// SPEC-V2 §9.7 — /control/:id. Full screen, outside the Shell, and private: access is decided by
// the server's `AgentDetail.isOwner`, never by comparing a wallet in the browser (a claim owner's
// public `ownerWallet` is null by design).
//
// Every panel below the control bar is the existing profile component. The only new ones are the
// bar, THINKING NOW, SURVIVAL and the owner actions.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AgentDetail } from '@vantra/shared';
import { api, isApiError } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { ClaimGate } from '../components/control/ClaimGate';
import { ControlBar } from '../components/control/ControlBar';
import { ControlOwnerPanel } from '../components/control/ControlOwnerPanel';
import { SurvivalPanel } from '../components/control/SurvivalPanel';
import { ThinkingPanel } from '../components/control/ThinkingPanel';
import { DecisionsPanel } from '../components/profile/DecisionsPanel';
import { LedgerPanel } from '../components/profile/LedgerPanel';
import { LivePanel } from '../components/profile/LivePanel';
import { ProjectsPanel } from '../components/profile/ProjectsPanel';
import { ServicesPanel } from '../components/profile/ServicesPanel';
import { StepsPanel } from '../components/profile/StepsPanel';
import { TreasuryChart } from '../components/profile/TreasuryChart';
import { useAgent, useAgentsStore } from '../store/agents';
import { useAppStore } from '../store/app';
import { useFeedStore } from '../store/feed';
import '../styles/pages1.css';
// The control board reuses the buy primitives (deposit address, claim input) in its gate and top-up.
import '../styles/pages2.css';

const EVENT_SEED = 80;
const STEP_SEED = 40;

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

export default function ControlBoard() {
  const { id = '' } = useParams<{ id: string }>();
  const meLoaded = useAppStore((s) => s.meLoaded);
  const me = useAppStore((s) => s.me);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const liveAgent = useAgent(id);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const next = await api.agent(id);
      const store = useAgentsStore.getState();
      store.upsert(next);
      store.setProjects(id, next.projects);
      if (!mounted.current) return;
      setDetail(next);
      setError(null);
      setState('ready');
    } catch (e) {
      if (!mounted.current) return;
      if (isApiError(e) && e.status === 404) {
        setState('missing');
        return;
      }
      setError(isApiError(e) ? e.message : 'Could not load this agent');
      setState((cur) => (cur === 'ready' ? cur : 'error'));
    }
  }, [id]);

  // `isOwner` is computed per session, so the detail is refetched whenever the session changes —
  // which is exactly what makes the claim gate unlock in place.
  useEffect(() => {
    setState('loading');
    setDetail(null);
    void load();
  }, [load, me?.ownerId]);

  useEffect(() => {
    if (!id) return;
    let live = true;
    void Promise.all([api.agentEvents(id, EVENT_SEED), api.agentSteps(id, STEP_SEED)])
      .then(([events, steps]) => {
        if (!live) return;
        useAgentsStore.getState().setSteps(id, steps);
        useFeedStore.getState().seedLive(id, events, steps);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [id]);

  const agent = useMemo<AgentDetail | null>(() => {
    if (!detail) return null;
    return liveAgent ? { ...detail, ...liveAgent } : detail;
  }, [detail, liveAgent]);

  const refresh = useCallback(() => { void load(); }, [load]);

  if (state === 'missing') {
    return (
      <div className="control-shell">
        <div className="control-empty">
          <EmptyState title="NO SUCH AGENT" text={`Nothing is running under id “${id}”.`}>
            <Link to="/mine" className="btn-ghost">MY AGENTS</Link>
          </EmptyState>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="control-shell">
        <div className="control-empty">
          {state === 'error' ? (
            <EmptyState title="LOAD FAILED" text={error ?? undefined}>
              <button type="button" className="btn-ghost" onClick={() => void load()}>RETRY</button>
            </EmptyState>
          ) : (
            <EmptyState title="OPENING CONTROL BOARD…" />
          )}
        </div>
      </div>
    );
  }

  if (!agent.isOwner) {
    // Wait for /api/me before accusing the viewer of not owning it: on a cold reload the session
    // cookie is still being checked and the first detail fetch can legitimately say false.
    if (!meLoaded) {
      return (
        <div className="control-shell">
          <div className="control-empty"><EmptyState title="CHECKING YOUR SESSION…" /></div>
        </div>
      );
    }
    return (
      <div className="control-shell">
        <ClaimGate agentId={agent.id} agentName={agent.name} />
      </div>
    );
  }

  return (
    <div className="control-shell">
      <ControlBar agent={agent} />
      <main className="control-main">
        {error && <div className="alert err">{error}</div>}
        {agent.spawnError && (
          <div className="alert err">
            <span>{agent.spawnError} — your money is safe; the protocol retries this automatically.</span>
          </div>
        )}

        <div className="control-grid">
          <div className="cg-col cg-wide">
            <ThinkingPanel agent={agent} />
            <div className="section-gap"><StepsPanel agent={agent} /></div>
            <div className="section-gap"><LivePanel agent={agent} /></div>
            <div className="section-gap"><DecisionsPanel agent={agent} /></div>
          </div>
          <div className="cg-col">
            <SurvivalPanel agent={agent} />
            <div className="section-gap"><TreasuryChart agent={agent} /></div>
            <div className="section-gap"><ProjectsPanel agent={agent} /></div>
            <div className="section-gap"><ServicesPanel agent={agent} /></div>
          </div>
        </div>

        <ControlOwnerPanel agent={agent} refresh={refresh} />

        <div className="section-gap"><LedgerPanel agent={agent} /></div>

        <div className="note">
          This board is private to you. Everything the agent does in public — its profile, its sites, its services and
          its grave — is at <Link to={`/a/${agent.id}`}>/a/{agent.id}</Link>.
        </div>
      </main>
    </div>
  );
}
