import type { Clock } from '../core/interfaces.js';

export const systemClock: Clock = { now: () => new Date() };

// Demo clock: frozen virtual time that only moves on advance()/set(), until release()
// hands control back to the wall clock so the live scheduler keeps stepping in real time.
export class FastClock implements Clock {
  private virtualMs: number;
  private live = false;

  constructor(start: Date = new Date()) {
    this.virtualMs = start.getTime();
  }

  now(): Date {
    return this.live ? new Date() : new Date(this.virtualMs);
  }

  get isLive(): boolean {
    return this.live;
  }

  advance(ms: number): void {
    if (this.live) throw new Error('FastClock.advance() after release()');
    if (ms < 0) throw new Error('FastClock.advance() needs a non-negative duration');
    this.virtualMs += ms;
  }

  set(date: Date): void {
    if (this.live) throw new Error('FastClock.set() after release()');
    this.virtualMs = date.getTime();
  }

  release(): void {
    this.live = true;
  }
}
