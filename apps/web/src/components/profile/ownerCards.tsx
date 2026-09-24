// Owner action cards, lifted out of the v1 profile OwnerPanel so the control board owns them
// (SPEC-V2 §9.7). Nothing here is restyled: they are the same `.owner-card` blocks as v1.
import { useState } from 'react';
import { DEFAULT_HEARTBEAT_MIN, MAX_HEARTBEAT_MIN, tierById } from '@vantra/shared';
import { api } from '../../api/client';
import { useAction } from './common';
import type { OwnerProps } from './common';
import { fmtDateTime } from '../../lib/format';

const HEARTBEATS = [30, 60, 120, 240, 720];
const MESSAGE_MAX = 1_000;

export function PauseCard({ agent, refresh }: OwnerProps) {
  const { busy, error, run } = useAction(refresh);
  const paused = agent.status === 'paused';

  return (
    <div className="owner-card">
      <div className="oc-title">{paused ? 'PAUSED' : 'RUNNING'}</div>
      <div className="form-row">
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void run(() => api.pause(agent.id, !paused))}>
          {busy ? 'WORKING…' : paused ? 'RESUME' : 'PAUSE'}
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
      <div className="note">A paused agent stops stepping and its sandbox is stopped, but it still pays the reduced sleep rent.</div>
    </div>
  );
}

/**
 * An owner may slow an agent down, but not speed it past its tier's floor: the tier's heartbeat is
 * the fastest it was ever priced for, and going faster would silently shorten the life the buyer
 * was quoted.
 */
export function HeartbeatCard({ agent, refresh }: OwnerProps) {
  const { busy, error, run } = useAction(refresh);
  const tier = agent.tierId ? tierById(agent.tierId) : undefined;
  const floor = tier?.heartbeatMin ?? 0;
  const options = [...new Set([...HEARTBEATS, agent.heartbeatMin])].sort((a, b) => a - b);

  return (
    <div className="owner-card">
      <div className="oc-title">HEARTBEAT</div>
      <div className="seg">
        {options.map((m) => {
          const tooFast = m < floor;
          return (
            <button
              key={m}
              type="button"
              className={agent.heartbeatMin === m ? 'active' : undefined}
              disabled={busy || agent.heartbeatMin === m || tooFast || m > MAX_HEARTBEAT_MIN}
              title={tooFast ? `${tier?.label} runs no faster than ${floor}m` : undefined}
              onClick={() => void run(() => api.updateAgent(agent.id, { heartbeatMin: m }))}
            >
              {m}m
            </button>
          );
        })}
      </div>
      {error && <div className="alert err">{error}</div>}
      <div className="note">
        Steps run every {agent.heartbeatMin} minutes (protocol default {DEFAULT_HEARTBEAT_MIN}).
        {tier ? ` ${tier.label} may run as fast as ${floor}m and no faster.` : ''} Slower means fewer chances to earn and a
        longer life.
      </div>
    </div>
  );
}

export function ShareCard({ agent, refresh }: OwnerProps) {
  const { busy, error, run } = useAction(refresh);

  return (
    <div className="owner-card">
      <div className="oc-title">STRATEGY</div>
      <div className="seg">
        <button
          type="button"
          className={agent.shareStrategy ? 'active' : undefined}
          disabled={busy || agent.shareStrategy}
          onClick={() => void run(() => api.updateAgent(agent.id, { shareStrategy: true }))}
        >
          PUBLIC
        </button>
        <button
          type="button"
          className={!agent.shareStrategy ? 'active' : undefined}
          disabled={busy || !agent.shareStrategy}
          onClick={() => void run(() => api.updateAgent(agent.id, { shareStrategy: false }))}
        >
          PRIVATE
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
      <div className="note">
        {agent.hasStrategy
          ? 'A public strategy can be forked by anyone; forks pay 5% of their external revenue to this agent.'
          : 'This agent has not published a strategy yet.'}
      </div>
    </div>
  );
}

export function MessageCard({ agent, refresh }: OwnerProps) {
  const { busy, error, run } = useAction(refresh);
  const [text, setText] = useState('');

  const send = () =>
    run(async () => {
      await api.messageAgent(agent.id, text.trim());
      setText('');
    });

  return (
    <div className="owner-card span-2">
      <div className="oc-title">MESSAGE THE AGENT</div>
      <textarea
        className="finput"
        rows={3}
        value={text}
        maxLength={MESSAGE_MAX}
        placeholder="Delivered with the next heartbeat…"
        onChange={(e) => setText(e.target.value)}
        aria-label="Message to the agent"
      />
      <div className="form-row section-gap">
        <span className="faint">
          {text.length}/{MESSAGE_MAX}
        </span>
        <span className="spacer" />
        <button type="button" className="btn-ghost" disabled={busy || text.trim().length === 0} onClick={() => void send()}>
          {busy ? 'SENDING…' : 'SEND'}
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
      <div className="note">A message wakes the agent early: it steps as soon as the minimum gap allows instead of waiting for its heartbeat.</div>
      {agent.ownerMessages.length > 0 && (
        <div className="msg-thread">
          {agent.ownerMessages.map((m) => (
            <div className={m.from === 'owner' ? 'msg owner' : 'msg'} key={m.id}>
              <span className="msg-ts">
                {m.from === 'owner' ? 'YOU' : agent.name} · {fmtDateTime(m.ts)}
              </span>
              <div>{m.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TerminateCard({ agent, refresh }: OwnerProps) {
  const { busy, error, run } = useAction(refresh);
  const [confirm, setConfirm] = useState('');
  const phrase = `TERMINATE ${agent.name}`;

  return (
    <div className="owner-card">
      <div className="oc-title">TERMINATE</div>
      <div className="form-row">
        <input
          className="finput"
          value={confirm}
          placeholder={phrase}
          onChange={(e) => setConfirm(e.target.value)}
          aria-label={`Type ${phrase} to confirm`}
        />
        <button type="button" className="btn-danger" disabled={busy || confirm !== phrase} onClick={() => void run(() => api.terminate(agent.id, phrase))}>
          {busy ? 'KILLING…' : 'TERMINATE'}
        </button>
      </div>
      {error && <div className="alert err">{error}</div>}
      <div className="note">
        Kills the agent immediately and destroys its sandbox. Type “{phrase}” to confirm. Remaining treasury becomes withdrawable with no age rule.
      </div>
    </div>
  );
}
