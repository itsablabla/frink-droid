import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectDroidAccount,
  droidAuthFilePath,
  parseDroidAuthBlob,
  resolveDroidHome,
} from './detect-droid';

// Real fixtures (a temp FACTORY_HOME + a real auth.json) instead of fs mocks,
// matching detect-codex.test.ts. electron-log is globally mocked in vitest.setup.ts.

let factoryHome: string;
const originalFactoryHome = process.env.FACTORY_HOME;

beforeEach(() => {
  factoryHome = mkdtempSync(join(tmpdir(), 'factory-home-'));
  process.env.FACTORY_HOME = factoryHome;
});

afterEach(() => {
  rmSync(factoryHome, { recursive: true, force: true });
  if (originalFactoryHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = originalFactoryHome;
});

function makeJwt(claims: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

describe('resolveDroidHome / droidAuthFilePath', () => {
  it('honours FACTORY_HOME and derives the auth path from it', () => {
    expect(resolveDroidHome()).toBe(factoryHome);
    expect(droidAuthFilePath()).toBe(join(factoryHome, 'auth.json'));
  });
});

describe('parseDroidAuthBlob', () => {
  it('accepts an access_token and reads the top-level email', () => {
    expect(
      parseDroidAuthBlob(JSON.stringify({ access_token: 'tok', email: 'me@factory.ai' })),
    ).toEqual({ email: 'me@factory.ai' });
  });

  it('falls back to user.email, then the JWT email claim', () => {
    expect(
      parseDroidAuthBlob(JSON.stringify({ accessToken: 'tok', user: { email: 'u@factory.ai' } })),
    ).toEqual({ email: 'u@factory.ai' });
    expect(
      parseDroidAuthBlob(JSON.stringify({ id_token: makeJwt({ email: 'jwt@factory.ai' }) })),
    ).toEqual({ email: 'jwt@factory.ai' });
  });

  it('accepts an api_key credential with no email', () => {
    expect(parseDroidAuthBlob(JSON.stringify({ api_key: 'fk-123' }))).toEqual({
      email: undefined,
    });
  });

  it('rejects empty, malformed, and credential-less blobs', () => {
    expect(parseDroidAuthBlob('')).toBeNull();
    expect(parseDroidAuthBlob('not json')).toBeNull();
    expect(parseDroidAuthBlob(JSON.stringify({ email: 'me@factory.ai' }))).toBeNull();
  });
});

describe('detectDroidAccount', () => {
  it('reports unavailable with a sign-in hint when auth.json is absent', () => {
    const result = detectDroidAccount();
    expect(result.available).toBe(false);
    expect(result.hint).toMatch(/sign in/i);
  });

  it('reports unavailable when auth.json carries no credential', () => {
    writeFileSync(join(factoryHome, 'auth.json'), '{}');
    const result = detectDroidAccount();
    expect(result.available).toBe(false);
    expect(result.hint).toMatch(/sign in again/i);
  });

  it('reports available with identity metadata on a valid login', () => {
    writeFileSync(
      join(factoryHome, 'auth.json'),
      JSON.stringify({ access_token: 'tok', email: 'me@factory.ai' }),
    );
    expect(detectDroidAccount()).toEqual({
      available: true,
      email: 'me@factory.ai',
      displayName: 'me@factory.ai',
      sourcePath: 'droid-passthrough://local',
    });
  });
});
