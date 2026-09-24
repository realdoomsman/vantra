import { create } from 'zustand';
import type { AgentPublic, Project, StepPublic } from '@vantra/shared';

const MAX_STEPS_PER_AGENT = 60;

interface AgentsState {
  /** Every agent this session has seen, keyed by id; live-patched from WS. */
  byId: Record<string, AgentPublic>;
  /** Ordered id lists for pages (e.g. 'agents:alive', 'observatory:earners'). */
  lists: Record<string, string[]>;
  /** Recent steps per agent, newest first; upserted by id from WS 'step'. */
  stepsByAgent: Record<string, StepPublic[]>;
  /** Projects per agent, upserted from WS 'project' and AgentDetail. */
  projectsByAgent: Record<string, Project[]>;

  upsert: (agents: AgentPublic | AgentPublic[]) => void;
  /** Shallow-merge a WS patch. Patches for agents not yet loaded are dropped. */
  patch: (agentId: string, patch: Partial<AgentPublic>) => void;
  setList: (key: string, rows: AgentPublic[]) => void;
  setSteps: (agentId: string, steps: StepPublic[]) => void;
  upsertStep: (step: StepPublic) => void;
  setProjects: (agentId: string, projects: Project[]) => void;
  upsertProject: (project: Project) => void;
}

const byStepDesc = (a: StepPublic, b: StepPublic) => b.n - a.n;

export const useAgentsStore = create<AgentsState>()((set) => ({
  byId: {},
  lists: {},
  stepsByAgent: {},
  projectsByAgent: {},

  upsert: (input) =>
    set((s) => {
      const rows = Array.isArray(input) ? input : [input];
      if (rows.length === 0) return s;
      const byId = { ...s.byId };
      for (const a of rows) byId[a.id] = a;
      return { byId };
    }),

  patch: (agentId, patch) =>
    set((s) => {
      const cur = s.byId[agentId];
      if (!cur) return s;
      return { byId: { ...s.byId, [agentId]: { ...cur, ...patch } } };
    }),

  setList: (key, rows) =>
    set((s) => {
      const byId = { ...s.byId };
      for (const a of rows) byId[a.id] = a;
      return { byId, lists: { ...s.lists, [key]: rows.map((a) => a.id) } };
    }),

  setSteps: (agentId, steps) =>
    set((s) => ({ stepsByAgent: { ...s.stepsByAgent, [agentId]: [...steps].sort(byStepDesc).slice(0, MAX_STEPS_PER_AGENT) } })),

  upsertStep: (step) =>
    set((s) => {
      const cur = s.stepsByAgent[step.agentId] ?? [];
      const next = cur.some((x) => x.id === step.id) ? cur.map((x) => (x.id === step.id ? step : x)) : [step, ...cur];
      return { stepsByAgent: { ...s.stepsByAgent, [step.agentId]: next.sort(byStepDesc).slice(0, MAX_STEPS_PER_AGENT) } };
    }),

  setProjects: (agentId, projects) =>
    set((s) => ({ projectsByAgent: { ...s.projectsByAgent, [agentId]: projects } })),

  upsertProject: (project) =>
    set((s) => {
      const cur = s.projectsByAgent[project.agentId] ?? [];
      const next = cur.some((p) => p.id === project.id) ? cur.map((p) => (p.id === project.id ? project : p)) : [...cur, project];
      return { projectsByAgent: { ...s.projectsByAgent, [project.agentId]: next } };
    }),
}));

const EMPTY_IDS: string[] = [];

/** Live rows for a list key, in the order the page stored them. */
export function useAgentList(key: string): AgentPublic[] {
  const ids = useAgentsStore((s) => s.lists[key] ?? EMPTY_IDS);
  const byId = useAgentsStore((s) => s.byId);
  return ids.map((id) => byId[id]).filter((a): a is AgentPublic => a !== undefined);
}

export function useAgent(id: string | null | undefined): AgentPublic | undefined {
  return useAgentsStore((s) => (id ? s.byId[id] : undefined));
}
