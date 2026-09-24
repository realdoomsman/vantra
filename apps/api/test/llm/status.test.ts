// STATUS parsing for the mock provider. runtime/context.ts owns the exact wording, so this only
// pins the tolerance: read what is there, ignore what is not, never throw.
import { describe, expect, it } from 'vitest';
import { BLANK_STATUS, readStatus } from '../../src/llm/providers/mock/status.js';
import { STATUS_TEXT } from './helpers.js';

describe('readStatus', () => {
  it('reads the fields the mock plans against', () => {
    expect(readStatus([STATUS_TEXT({ runwayDays: 3.5, treasuryMicro: 1_500_000, siteUrl: 'https://sites.test/abc/' })])).toEqual({
      model: 'mock-strong',
      treasuryMicro: 1_500_000,
      runwayDays: 3.5,
      aboutToDie: false,
      liveProjects: 0,
      services: 0,
      siteUrl: 'https://sites.test/abc/',
      memoryNotes: 1,
      ownerMessages: 0,
    });
  });

  it('counts only live projects', () => {
    const status = readStatus([STATUS_TEXT({
      projects: [{ name: 'a', status: 'live' }, { name: 'b', status: 'building' }, { name: 'c', status: 'live' }],
      services: [{ id: 'sv_aaaaaaaaaa', name: 'x' }],
    })]);
    expect(status).toMatchObject({ liveProjects: 2, services: 1 });
  });

  it('accepts dollars and formatted money as well as micro-dollars', () => {
    expect(readStatus([`{"treasuryUsd": 4.25, "runwayDays": 9}`]).treasuryMicro).toBe(4_250_000);
    expect(readStatus([`{"treasury": "$1,234.50", "runway": "12.5 days"}`])).toMatchObject({ treasuryMicro: 1_234_500_000, runwayDays: 12.5 });
  });

  it('prefers the STATUS object over unrelated JSON earlier in the turn', () => {
    const text = `Tool output was {"ok": true, "bytes": 12}\n\nSTATUS\n${JSON.stringify({ model: 'mock-fast', treasuryMicro: 7_000_000, runwayDays: 2 })}`;
    expect(readStatus([text])).toMatchObject({ model: 'mock-fast', treasuryMicro: 7_000_000 });
  });

  it('takes the newest turn that carries a STATUS', () => {
    const newest = STATUS_TEXT({ treasuryMicro: 1_000_000 });
    const older = STATUS_TEXT({ treasuryMicro: 9_000_000 });
    expect(readStatus([newest, older]).treasuryMicro).toBe(1_000_000);
  });

  it('falls back to a blank snapshot when nothing parses', () => {
    expect(readStatus(['no json here at all', '{ broken', ''])).toEqual(BLANK_STATUS);
    expect(readStatus([])).toEqual(BLANK_STATUS);
  });

  it('is not confused by braces inside strings', () => {
    expect(readStatus([`{"summary": "wrote {\\"a\\": 1} to disk", "treasuryMicro": 500000, "runwayDays": 1}`]))
      .toMatchObject({ treasuryMicro: 500_000, runwayDays: 1 });
  });
});
