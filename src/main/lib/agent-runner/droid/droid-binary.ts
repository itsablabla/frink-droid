/**
 * Factory Droid CLI binary resolver.
 *
 * Unlike Codex (bundled, patched build) the droid binary is USER-INSTALLED: Frink
 * does not bundle it, mirroring the passthrough auth model — the `droid` CLI owns
 * both its install and its credentials (`~/.factory`). The resolver only needs to
 * LOCATE the binary, not authenticate.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Well-known install locations checked before PATH (the installer's default targets). */
function wellKnownLocations(): string[] {
  const home = homedir();
  return [
    join(home, '.local', 'bin', 'droid'),
    join(home, '.factory', 'bin', 'droid'),
    '/usr/local/bin/droid',
    '/opt/homebrew/bin/droid',
  ];
}

/**
 * Absolute path to the user-installed `droid` binary, or null when absent.
 * `pathEnv` is injectable so callers can pass the login-shell PATH (GUI apps on
 * macOS don't inherit it) and tests need no real install.
 */
export function resolveDroidBinary(pathEnv: string | undefined = process.env.PATH): string | null {
  for (const candidate of wellKnownLocations()) {
    if (existsSync(candidate)) return candidate;
  }
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'droid');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * User-facing message when the droid binary is missing. Install guidance only —
 * auth guidance lives in the connect flow's detector hints.
 */
export function getDroidCliMissingMessage(): string {
  return 'Droid isn’t installed on this machine. Install the Factory Droid CLI and sign in with `droid`, then try again.';
}
