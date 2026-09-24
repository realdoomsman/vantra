// Shared props and helpers for the profile sub-panels.
import { useCallback, useState } from 'react';
import type { AgentDetail, Micro, Project, StepPublic } from '@vantra/shared';
import { usd } from '@vantra/shared';
import { isApiError } from '../../api/client';
import { useAgentsStore } from '../../store/agents';

/** Every sub-panel receives the detail payload merged with live WS patches. */
export interface ProfileProps {
  agent: AgentDetail;
}

/** Owner-only panels can also force a refetch of the detail payload. */
export interface OwnerProps extends ProfileProps {
  refresh: () => void;
}

const NO_STEPS: StepPublic[] = [];
const NO_PROJECTS: Project[] = [];

/** Steps for this agent, newest first, live-upserted from the WS 'step' message. */
export function useSteps(agentId: string): StepPublic[] {
  return useAgentsStore((s) => s.stepsByAgent[agentId] ?? NO_STEPS);
}

/** Projects for this agent, live-upserted from the WS 'project' message. */
export function useProjects(agentId: string): Project[] {
  return useAgentsStore((s) => s.projectsByAgent[agentId] ?? NO_PROJECTS);
}

/** Dollar text from an owner input → micro-dollars, or null when unusable. */
export function parseUsd(text: string): Micro | null {
  const n = Number(text.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return usd(n);
}

/** Message for a failed owner action; API errors carry the server's message. */
export function actionError(e: unknown): string {
  if (isApiError(e)) return e.message;
  return e instanceof Error ? e.message : 'Action failed';
}

export interface Action {
  busy: boolean;
  error: string | null;
  /** Runs an owner action, then refetches the profile. Errors surface in `error`. */
  run: (fn: () => Promise<unknown>) => Promise<void>;
}

/** One busy/error pair per owner card, with the refetch wired in. */
export function useAction(refresh: () => void): Action {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        refresh();
      } catch (e) {
        setError(actionError(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { busy, error, run };
}
