// Loads .env from the repo root (and the cwd as a fallback) without overriding real env.
import { config as dotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/api/{src,dist}/lib/env.ts → repo root is four levels up in both layouts.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const API_ROOT = path.resolve(REPO_ROOT, 'apps/api');

export function loadDotenv(): void {
  const candidates = [path.join(REPO_ROOT, '.env'), path.join(process.cwd(), '.env')];
  for (const file of candidates) {
    if (existsSync(file)) dotenv({ path: file, override: false, quiet: true });
  }
}
