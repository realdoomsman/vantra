// The launch, step by step: prepare on the server → the dev's wallet signs the exact factory call →
// wait for the block → the server verifies it on chain and lists the coin. In memory mode the wallet
// and the block are replaced by one simulated launch, the way the buy flow's SIMULATE PAYMENT is.
//
// Two things are kept so no step is ever lost:
// - the prepared launch is reused while the form is unchanged, so a rejected signature retried
//   does not strand a second dormant agent;
// - a signed hash is written to localStorage before the block is awaited. A dev who closes the tab
//   after signing has a coin on chain that is not yet listed; /launch offers to confirm it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import type { LaunchPrepareRequest, LaunchPrepareResponse, LaunchPublic } from '@vantra/shared';
import { api, isApiError } from '../../api/client';
import { usePublicClient, useWallet } from '../../providers/WalletProvider';
import { useWalletStore } from '../../store/wallet';

export type LaunchStep = 'prepare' | 'sign' | 'block' | 'confirm' | 'simulate';

/** What a failed step can do next: re-run everything, sign again, or re-ask the server to verify. */
export type LaunchRetry = 'restart' | 'resign' | 'reconfirm';

export type LaunchFlow =
  | { kind: 'idle' }
  | { kind: 'running'; step: LaunchStep; hash: string | null }
  | { kind: 'failed'; step: LaunchStep; launchId: string | null; message: string; hash: string | null; retry: LaunchRetry }
  | { kind: 'done'; launch: LaunchPublic };

/** A signed launch the server has not confirmed yet. */
export interface PendingLaunch {
  launchId: string;
  agentId: string;
  ticker: string;
  txSig: string;
}

const PENDING_KEY = 'vantra:pending-launch';
const RECEIPT_TIMEOUT_MS = 120_000;

export function readPending(): PendingLaunch | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingLaunch>;
    return p.launchId && p.agentId && p.txSig && p.ticker ? (p as PendingLaunch) : null;
  } catch {
    return null;
  }
}

export function writePending(p: PendingLaunch | null): void {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Private mode: the resume offer is lost, the launch itself is not.
  }
}

/** viem errors carry a one-line `shortMessage`; their `message` is a multi-paragraph dump. */
function errMessage(e: unknown, fallback: string): string {
  if (isApiError(e)) return e.message;
  if (e && typeof e === 'object' && 'shortMessage' in e && typeof e.shortMessage === 'string') return e.shortMessage;
  return e instanceof Error ? e.message : fallback;
}

export function useLaunchFlow({ simulate }: { simulate: boolean }) {
  const [flow, setFlow] = useState<LaunchFlow>({ kind: 'idle' });
  const prepared = useRef<{ key: string; res: LaunchPrepareResponse } | null>(null);
  /** Wei the prepared call carries — Pons's launch fee, read live by the server when it built the call. */
  const [feeWei, setFeeWei] = useState<bigint | null>(null);
  const alive = useRef(true);
  const publicClient = usePublicClient();
  const { publicKey, walletClient, wrongNetwork, chain } = useWallet();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const set = useCallback((next: LaunchFlow) => {
    if (alive.current) setFlow(next);
  }, []);

  const finish = useCallback(
    (launch: LaunchPublic) => {
      writePending(null);
      prepared.current = null;
      setFeeWei(null);
      void useWalletStore.getState().refreshMe();
      set({ kind: 'done', launch });
    },
    [set],
  );

  /** The server verifies the signed transaction on chain; a 400 means it never will. */
  const confirm = useCallback(
    async (launchId: string, hash: string) => {
      set({ kind: 'running', step: 'confirm', hash });
      try {
        finish(await api.confirmLaunch(launchId, hash));
      } catch (e) {
        const permanent = isApiError(e) && e.code === 'INVALID_TX';
        if (permanent) {
          writePending(null);
          prepared.current = null;
          setFeeWei(null);
        }
        set({
          kind: 'failed',
          step: 'confirm',
          launchId,
          hash,
          message: errMessage(e, 'The server could not confirm the launch.'),
          retry: permanent ? 'restart' : 'reconfirm',
        });
      }
    },
    [finish, set],
  );

  const start = useCallback(
    async (body: LaunchPrepareRequest) => {
      const key = JSON.stringify(body);
      let prep = prepared.current?.key === key ? prepared.current.res : null;

      if (!prep) {
        set({ kind: 'running', step: 'prepare', hash: null });
        try {
          prep = await api.prepareLaunch(body);
          prepared.current = { key, res: prep };
          setFeeWei(BigInt(prep.call.value));
        } catch (e) {
          set({ kind: 'failed', step: 'prepare', launchId: null, hash: null, message: errMessage(e, 'Could not prepare the launch.'), retry: 'restart' });
          return;
        }
      }
      const { launch, call } = prep;

      if (simulate) {
        set({ kind: 'running', step: 'simulate', hash: null });
        try {
          finish(await api.simulateLaunch(launch.id));
        } catch (e) {
          set({ kind: 'failed', step: 'simulate', launchId: launch.id, hash: null, message: errMessage(e, 'The simulated launch failed.'), retry: 'resign' });
        }
        return;
      }

      set({ kind: 'running', step: 'sign', hash: null });
      let hash: `0x${string}`;
      try {
        if (!publicKey || !walletClient) throw new Error('Connect a wallet first.');
        if (wrongNetwork) throw new Error(`Switch the wallet to ${chain.name} first.`);
        if (call.chainId !== chain.id) {
          throw new Error(`The server prepared a call for chain ${call.chainId}, but this app is on ${chain.name} (${chain.id}).`);
        }
        hash = await walletClient.sendTransaction({
          account: publicKey as Address,
          chain: walletClient.chain,
          to: call.to,
          data: call.data,
          value: BigInt(call.value),
        });
      } catch (e) {
        set({ kind: 'failed', step: 'sign', launchId: launch.id, hash: null, message: errMessage(e, 'The wallet did not send the launch.'), retry: 'resign' });
        return;
      }
      writePending({ launchId: launch.id, agentId: launch.agentId, ticker: launch.ticker, txSig: hash });

      set({ kind: 'running', step: 'block', hash });
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: RECEIPT_TIMEOUT_MS });
        if (receipt.status === 'reverted') {
          writePending(null);
          set({
            kind: 'failed',
            step: 'block',
            launchId: launch.id,
            hash,
            message: 'The launch transaction reverted on chain. No coin was created; only gas was spent.',
            retry: 'resign',
          });
          return;
        }
      } catch (e) {
        set({
          kind: 'failed',
          step: 'block',
          launchId: launch.id,
          hash,
          message: `${errMessage(e, 'No receipt yet.')} The transaction may still land — CONFIRM asks the server to check the chain.`,
          retry: 'reconfirm',
        });
        return;
      }

      await confirm(launch.id, hash);
    },
    [simulate, publicKey, walletClient, wrongNetwork, chain, publicClient, confirm, finish, set],
  );

  const reset = useCallback(() => set({ kind: 'idle' }), [set]);

  return { flow, feeWei, start, confirm, reset };
}
