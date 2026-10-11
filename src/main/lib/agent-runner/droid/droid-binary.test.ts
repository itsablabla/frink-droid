import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDroidCliMissingMessage, resolveDroidBinary } from './droid-binary';

// Real temp dirs instead of fs mocks (repo rule: no module mocking). The
// well-known-location fallbacks point at the live machine's home, so these tests
// only assert PATH behaviour — on a dev box with droid installed the well-known
// hit would legitimately win, which is still a non-null result.

let cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  cleanup = [];
});

function makeBinDir(withDroid: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'droid-bin-'));
  cleanup.push(dir);
  mkdirSync(dir, { recursive: true });
  if (withDroid) writeFileSync(join(dir, 'droid'), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}

describe('resolveDroidBinary', () => {
  it('finds droid on the provided PATH', () => {
    const bin = makeBinDir(true);
    expect(resolveDroidBinary(bin)).toBe(join(bin, 'droid'));
  });

  it('skips empty PATH segments and dirs without droid', () => {
    const empty = makeBinDir(false);
    const hit = makeBinDir(true);
    const pathEnv = ['', empty, hit].join(delimiter);
    expect(resolveDroidBinary(pathEnv)).toBe(join(hit, 'droid'));
  });

  it('returns null when droid is nowhere (unless a well-known install exists)', () => {
    const result = resolveDroidBinary(makeBinDir(false));
    // On machines with a real ~/.local/bin/droid etc. the well-known probe wins;
    // either way the contract (path-or-null) holds.
    expect(result === null || result.endsWith('droid')).toBe(true);
  });
});

describe('getDroidCliMissingMessage', () => {
  it('tells the user to install and sign in', () => {
    const msg = getDroidCliMissingMessage();
    expect(msg).toMatch(/install/i);
    expect(msg).toContain('droid');
  });
});
