import { describe, expect, it } from 'vitest';
import type { TreasuryPublic } from '@vantra/shared';
import { createBus } from '../src/core/bus.js';
import { silentLogger } from '../src/lib/log.js';

describe('createBus', () => {
  it('dispatches by type and to onAny, and unsubscribes', () => {
    const bus = createBus(silentLogger);
    const seen: string[] = [];
    const off = bus.on('treasury', (m) => seen.push(`treasury:${m.treasury.usdcMicro}`));
    bus.onAny((m) => seen.push(`any:${m.type}`));
    const treasury = { usdcMicro: 5 } as unknown as TreasuryPublic;
    bus.emit({ type: 'treasury', treasury });
    off();
    bus.emit({ type: 'treasury', treasury });
    expect(seen).toEqual(['treasury:5', 'any:treasury', 'any:treasury']);
  });
  it('isolates listener errors', () => {
    const bus = createBus(silentLogger);
    bus.onAny(() => { throw new Error('boom'); });
    const seen: string[] = [];
    bus.onAny((m) => seen.push(m.type));
    expect(() => bus.emit({ type: 'stats', stats: {} as never })).not.toThrow();
    expect(seen).toEqual(['stats']);
  });
});
