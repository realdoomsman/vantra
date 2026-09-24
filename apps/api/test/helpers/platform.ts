// Host capabilities the suite cannot assume. The product deploys on Linux; these let the same tests
// run on a Windows dev box without pretending its filesystem behaves like ext4.
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Windows only lets administrators (or Developer Mode) create symlinks. Probe once, cache the answer. */
export async function canSymlink(): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vantra-symlink-probe-'));
  try {
    await symlink(path.join(dir, 'target'), path.join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `sh` on Windows is MSYS: it reports POSIX-style paths (`/tmp/...`) that no Node API can compare to the real cwd. */
export const POSIX_SHELL = process.platform !== 'win32';
