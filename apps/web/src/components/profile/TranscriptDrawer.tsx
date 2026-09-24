// Step transcript drawer: the public transcript (thinking stripped, tool payloads
// truncated server-side). 404 means it has been pruned (AMENDMENTS C25/D33).
import { useEffect, useState } from 'react';
import { TRANSCRIPT_RETENTION_DAYS, fmtUsd } from '@vantra/shared';
import type { StepPublic, StepTranscript, TranscriptBlock } from '@vantra/shared';
import { api, isApiError } from '../../api/client';
import { EmptyState } from '../EmptyState';
import { fmtDateTime } from '../../lib/format';

interface Props {
  agentId: string;
  step: StepPublic;
  onClose: () => void;
}

export function TranscriptDrawer({ agentId, step, onClose }: Props) {
  const [transcript, setTranscript] = useState<StepTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pruned, setPruned] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setTranscript(null);
    setError(null);
    setPruned(false);
    api
      .stepTranscript(agentId, step.id)
      .then((t) => {
        if (live) setTranscript(t);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (isApiError(e) && e.status === 404) setPruned(true);
        else setError(isApiError(e) ? e.message : 'Could not load the transcript');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [agentId, step.id]);

  return (
    <>
      {/* Mouse-only dismissal; Escape and the CLOSE button are the keyboard paths, so the mask is
          hidden from assistive tech rather than exposed as a control that cannot be reached. */}
      <div className="drawer-mask" aria-hidden onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Step ${step.n} transcript`}>
        <div className="drawer-head">
          <span>
            STEP {step.n} · {step.model}
          </span>
          <span className="spacer" />
          <span className="faint">
            {fmtDateTime(step.startedAt)} · {fmtUsd(step.costMicro)} · {step.rounds} round{step.rounds === 1 ? '' : 's'}
          </span>
          <button type="button" className="copy-btn" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <div className="drawer-body">
          {loading && <EmptyState title="LOADING TRANSCRIPT…" />}
          {pruned && <EmptyState title="TRANSCRIPT PRUNED" text={`Full transcripts are kept for ${TRANSCRIPT_RETENTION_DAYS} days.`} />}
          {error && <div className="alert err">{error}</div>}
          {transcript?.messages.map((m, i) => (
            <div className="tm" key={i}>
              <div className="tm-role">{m.role}</div>
              {m.content.map((block, j) => (
                <Block key={j} block={block} />
              ))}
            </div>
          ))}
          {transcript && transcript.messages.length === 0 && <EmptyState title="EMPTY TRANSCRIPT" />}
        </div>
      </aside>
    </>
  );
}

function Block({ block }: { block: TranscriptBlock }) {
  if (block.type === 'text') {
    return (
      <div className="tm-block">
        <pre className="tm-pre">{block.text}</pre>
      </div>
    );
  }
  if (block.type === 'tool_use') {
    return (
      <div className="tm-block">
        <div className="tm-kind">→ {block.name}</div>
        <pre className="tm-pre">{block.input}</pre>
      </div>
    );
  }
  return (
    <div className="tm-block">
      <div className={block.isError ? 'tm-kind err' : 'tm-kind'}>← result{block.isError ? ' · error' : ''}</div>
      <pre className="tm-pre">{block.content}</pre>
    </div>
  );
}
