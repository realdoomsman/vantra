// SPEC §9 Profile: head, runway hero, tiles, charts, live panel, steps,
// projects, decisions, ledger, strategy, post-mortem and the owner panel.
// Detail comes from /api/agents/:id; everything else stays live over WS.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AgentDetail } from '@vantra/shared';
import { api, isApiError } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { LaunchPanel } from '../components/launch/LaunchPanel';
import { useAgentLaunch } from '../components/launch/useAgentLaunch';
import { BountiesPanel } from '../components/profile/BountiesPanel';
import { CreatorDashboard } from '../components/profile/CreatorDashboard';
import { DecisionsPanel } from '../components/profile/DecisionsPanel';
import { ForksPanel } from '../components/profile/ForksPanel';
import { LedgerPanel } from '../components/profile/LedgerPanel';
import { LivePanel } from '../components/profile/LivePanel';
import { PnlPanel } from '../components/profile/PnlPanel';
import { PositionsPanel } from '../components/profile/PositionsPanel';
import { PostmortemPanel } from '../components/profile/PostmortemPanel';
import { ProfileHead } from '../components/profile/ProfileHead';
import { ProfileTiles } from '../components/profile/ProfileTiles';
import { ProjectsPanel } from '../components/profile/ProjectsPanel';
import { ServicesPanel } from '../components/profile/ServicesPanel';
import { MemoryPanel, StrategyPanel } from '../components/profile/StrategyPanel';
import { StepsPanel } from '../components/profile/StepsPanel';
import { TreasuryChart } from '../components/profile/TreasuryChart';
import { useAgent, useAgentsStore } from '../store/agents';
import { useFeedStore } from '../store/feed';
import '../styles/pages1.css';

const EVENT_SEED = 50;
const STEP_SEED = 30;

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

export default function AgentProfile() {
  const { id = '' } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const liveAgent = useAgent(id);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
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

  useEffect(() => {
    setState('loading');
    setDetail(null);
    void load();
  }, [load]);

  // Seed the per-agent LIVE ring buffer and the steps table (D33).
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
    return () => {
      live = false;
    };
  }, [id]);

  const agent = useMemo<AgentDetail | null>(() => {
    if (!detail) return null;
    return liveAgent ? { ...detail, ...liveAgent } : detail;
  }, [detail, liveAgent]);

  const coin = useAgentLaunch(id, agent);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  if (state === 'missing') {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">AGENT NOT FOUND</h1>
          <p className="page-sub">No agent with id “{id}”.</p>
        </div>
        <EmptyState title="NOTHING HERE" text="The id is wrong, or the agent was never spawned.">
          <Link to="/agents" className="btn-ghost">
            ALL AGENTS
          </Link>
        </EmptyState>
      </>
    );
  }

  if (!agent) {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">AGENT</h1>
          <p className="page-sub">{state === 'error' ? 'Could not reach the observatory.' : 'Loading…'}</p>
        </div>
        {state === 'error' ? (
          <EmptyState title="LOAD FAILED" text={error ?? undefined}>
            <button type="button" className="btn-ghost" onClick={() => void load()}>
              RETRY
            </button>
          </EmptyState>
        ) : (
          <EmptyState title="LOADING AGENT…" />
        )}
      </>
    );
  }

  return (
    <>
      {error && <div className="alert err">{error}</div>}
      <ProfileHead agent={agent} launch={coin.launch} />
      {coin.launch && (
        <div className="section-gap">
          <LaunchPanel launch={coin.launch} stale={coin.error} reload={coin.reload} />
        </div>
      )}
      <ProfileTiles agent={agent} />
      <PostmortemPanel agent={agent} />

      <div className="grid cols-2 section-gap">
        <TreasuryChart agent={agent} />
        <PnlPanel agent={agent} />
      </div>

      <div className="section-gap">
        <PositionsPanel agent={agent} />
      </div>

      {agent.isOwner && <CreatorDashboard agent={agent} refresh={refresh} />}

      <div className="grid cols-2 section-gap">
        <LivePanel agent={agent} />
        <DecisionsPanel agent={agent} />
      </div>

      <div className="section-gap">
        <StepsPanel agent={agent} />
      </div>

      <div className="grid cols-2 section-gap">
        <ProjectsPanel agent={agent} />
        <ServicesPanel agent={agent} />
      </div>

      <div className="grid cols-2 section-gap">
        <BountiesPanel agent={agent} />
        <ForksPanel agent={agent} />
      </div>

      <div className="section-gap">
        <LedgerPanel agent={agent} />
      </div>

      <div className="grid cols-2 section-gap">
        <StrategyPanel agent={agent} />
        <MemoryPanel agent={agent} />
      </div>
    </>
  );
}
