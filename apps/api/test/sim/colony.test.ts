import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLS, DAY_MS, EFFORTS, FOUNDER_FEE_BPS_DEFAULT, MAX_HEARTBEAT_MIN, MIN_HEARTBEAT_MIN,
  MIN_PURCHASE_MICRO, TIERS, bpsOf, usd, validateName,
} from '@vantra/shared';
import { colonyCast } from '../../src/sim/colony.js';
import { PENDING_SALES } from '../../src/sim/demo.js';
import { isId } from '../../src/lib/ids.js';

const END = new Date('2026-09-16T12:00:00.000Z');
const cast = (over: Partial<Parameters<typeof colonyCast>[0]> = {}) =>
  colonyCast({ count: 36, seed: 42, days: 45, endAt: END, ...over });

describe('colonyCast', () => {
  it('is a pure function of the seed', () => {
    expect(cast()).toEqual(cast());
    expect(cast({ seed: 43 })).not.toEqual(cast());
  });

  it('produces unique, spawnable agents', () => {
    const members = cast();
    expect(members).toHaveLength(36);
    expect(new Set(members.map((m) => m.spawn.name)).size).toBe(36);
    expect(new Set(members.map((m) => m.spawn.ownerWallet)).size).toBe(36);
    expect(new Set(members.map((m) => m.spawn.agentId)).size).toBe(36);

    for (const { spawn } of members) {
      expect(validateName(spawn.name)).toEqual({ ok: true, name: spawn.name });
      expect(isId(spawn.agentId!, 'ag')).toBe(true);
      expect(spawn.directive.length).toBeGreaterThan(20);
      expect(spawn.tools.every((t) => ALL_TOOLS.includes(t))).toBe(true);
      expect(['mock-fast', 'mock-strong']).toContain(spawn.model);
      expect(EFFORTS).toContain(spawn.effort);
      expect(spawn.heartbeatMin).toBeGreaterThanOrEqual(MIN_HEARTBEAT_MIN);
      expect(spawn.heartbeatMin).toBeLessThanOrEqual(MAX_HEARTBEAT_MIN);
    }
  });

  it('spreads births across the window, oldest first, leaving room for the youngest to act', () => {
    const members = cast();
    const times = members.map((m) => m.bornAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeGreaterThanOrEqual(END.getTime() - 45 * DAY_MS);
    expect(times.at(-1)).toBeLessThan(END.getTime() - DAY_MS);
  });

  it('never asks for more agents than it has names for', () => {
    expect(cast({ count: 500 }).length).toBeLessThanOrEqual(60);
  });

  // v2: the colony is furniture, but it is furniture bought at the same prices a real buyer pays —
  // a real tier, and the 90% of that tier's floor a purchase would have left in the agent's wallet.
  it('buys every member at a real tier, for what that tier actually leaves the agent', () => {
    const members = cast();
    for (const { spawn } of members) {
      const tier = TIERS.find((t) => t.id === spawn.tierId);
      expect(tier, `unknown tier ${String(spawn.tierId)}`).toBeDefined();
      expect(spawn.fundingMicro).toBe(tier!.minMicro - bpsOf(tier!.minMicro, FOUNDER_FEE_BPS_DEFAULT));
      expect(spawn.ownerKind).toBe('wallet');
      expect(spawn.purchaseId).toBeNull();          // nobody paid: the colony is not a sale
    }
    expect(new Set(members.map((m) => m.spawn.tierId)).size).toBeGreaterThan(1);
  });
});

describe('demo pending purchases', () => {
  it('are buyable, unclaimed by the cast, and leave the part-paid one under the purchase minimum', () => {
    const taken = new Set(colonyCast({ count: 60, seed: 42, days: 45, endAt: END }).map((m) => m.spawn.name));
    expect(PENDING_SALES.length).toBeGreaterThan(0);
    for (const sale of PENDING_SALES) {
      expect(validateName(sale.name)).toEqual({ ok: true, name: sale.name });
      expect(taken.has(sale.name)).toBe(false);
      expect(usd(sale.amountUsd)).toBeGreaterThanOrEqual(MIN_PURCHASE_MICRO);
      expect(sale.directive.length).toBeGreaterThan(20);
      // A part-payment at or above the floor would be received and spawned, not left pending.
      expect(usd(sale.paidUsd)).toBeLessThan(MIN_PURCHASE_MICRO);
    }
    expect(PENDING_SALES.some((s) => s.paidUsd > 0)).toBe(true);
    expect(PENDING_SALES.some((s) => s.paidUsd === 0)).toBe(true);
  });
});
