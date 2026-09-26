// Prefixed, URL-safe identifiers: ag_x7k2m9p4q1 · bt_… · sv_… · pj_… · pu_… · la_… · im_…
// A purchase id is public (GET /api/purchases/:id needs no session) and is therefore relied on to be
// unguessable: 10 characters of a 36-symbol alphabet is ~51 bits.
import { customAlphabet } from 'nanoid';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LEN = 10;
const body = customAlphabet(ALPHABET, ID_LEN);

export type IdPrefix = 'ag' | 'bt' | 'sv' | 'pj' | 'pu' | 'la' | 'im';

export const newId = (prefix: IdPrefix): string => `${prefix}_${body()}`;
export const newAgentId = (): string => newId('ag');
export const newBountyId = (): string => newId('bt');
export const newServiceId = (): string => newId('sv');
export const newProjectId = (): string => newId('pj');
export const newPurchaseId = (): string => newId('pu');
export const newLaunchId = (): string => newId('la');
export const newImageId = (): string => newId('im');

const ID_RE = new RegExp(`^(ag|bt|sv|pj|pu|la|im)_[${ALPHABET}]{${ID_LEN}}$`);
export const isId = (s: string, prefix?: IdPrefix): boolean => ID_RE.test(s) && (prefix === undefined || s.startsWith(`${prefix}_`));
