import { describe, expect, it } from 'vitest';
import { FastClock, systemClock } from '../src/lib/clock.js';

describe('clocks', () => {
  it('systemClock tracks wall time', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(50);
  });
  it('FastClock freezes, advances and releases', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const c = new FastClock(start);
    expect(c.now().toISOString()).toBe(start.toISOString());
    c.advance(3_600_000);
    expect(c.now().toISOString()).toBe('2026-01-01T01:00:00.000Z');
    c.set(new Date('2026-02-01T00:00:00Z'));
    expect(c.now().getUTCMonth()).toBe(1);
    expect(() => c.advance(-1)).toThrow();
    c.release();
    expect(c.isLive).toBe(true);
    expect(Math.abs(c.now().getTime() - Date.now())).toBeLessThan(50);
    expect(() => c.advance(1)).toThrow();
  });
});
