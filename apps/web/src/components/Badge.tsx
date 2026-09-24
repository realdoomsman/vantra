import type { AgentPhase, AgentPublic, BountyStatus } from '@vantra/shared';
export type BadgeKind = AgentPhase | BountyStatus | 'sim';

interface BadgeProps {
  kind: BadgeKind;
  /** Override the uppercased kind text (e.g. "SPAWNING…"). */
  label?: string;
  className?: string;
}

/**
 * What a badge means when the word alone is ambiguous. DORMANT is neither asleep nor gone: a launched
 * AI with no money yet (or none left), waiting for its coin's trading fees to reach the threshold.
 */
const TITLE: Partial<Record<BadgeKind, string>> = {
  dormant: 'Waiting for its coin’s trading fees to reach the activation threshold. It wakes on its own.',
};

/** Status/phase badge (D30): text uppercased, class = kind. */
export function Badge({ kind, label, className }: BadgeProps) {
  return (
    <span className={['badge', kind, className ?? ''].filter(Boolean).join(' ')} title={TITLE[kind]}>
      <i />
      {(label ?? kind).toUpperCase()}
    </span>
  );
}

/** Phase badge plus the dashed SIM chip for mock-driven agents (D29). */
export function AgentBadges({ agent, label }: { agent: Pick<AgentPublic, 'phase' | 'simulated'>; label?: string }) {
  return (
    <>
      <Badge kind={agent.phase} label={label} />
      {agent.simulated && <Badge kind="sim" />}
    </>
  );
}
