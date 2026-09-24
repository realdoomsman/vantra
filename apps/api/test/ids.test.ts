import { describe, expect, it } from 'vitest';
import { isId, newAgentId, newBountyId, newProjectId, newServiceId } from '../src/lib/ids.js';

describe('ids', () => {
  it('generates prefixed 10-char ids', () => {
    expect(newAgentId()).toMatch(/^ag_[0-9a-z]{10}$/);
    expect(newBountyId()).toMatch(/^bt_[0-9a-z]{10}$/);
    expect(newServiceId()).toMatch(/^sv_[0-9a-z]{10}$/);
    expect(newProjectId()).toMatch(/^pj_[0-9a-z]{10}$/);
    expect(new Set(Array.from({ length: 100 }, newAgentId)).size).toBe(100);
  });
  it('validates ids by prefix', () => {
    const id = newAgentId();
    expect(isId(id)).toBe(true);
    expect(isId(id, 'ag')).toBe(true);
    expect(isId(id, 'bt')).toBe(false);
    expect(isId('ag_short')).toBe(false);
  });
});
