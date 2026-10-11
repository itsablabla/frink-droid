/**
 * Detect an existing Factory Droid login on this machine.
 *
 * Droid auth is PASSTHROUGH: the `droid` CLI owns the credential (written by the
 * CLI's own sign-in flow) under $FACTORY_HOME (defaults to ~/.factory). Frink NEVER
 * stores a Factory key and NEVER overrides FACTORY_HOME (that would break the
 * binary's auth). This module reads identity metadata ONLY — never the token — so
 * the UI can show "Connected to {email}". Token-less by design: the droid runner
 * relies on the binary's own auth at spawn, so there is no Frink token to resolve.
 *
 * Storage backend: $FACTORY_HOME/auth.json (written by `droid` on sign-in).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import log from 'electron-log';
import { sanitizeError } from './detect';

export type DetectDroidAccountResult = {
  /** True when the `droid` CLI has an authed identity on this machine. */
  available: boolean;
  /** "you@example.com" from the stored identity, when present. */
  email?: string;
  /** Friendly identifier for UI. */
  displayName?: string;
  /** Informational marker — droid owns its own auth, Frink resolves no token. */
  sourcePath?: string;
  /** Short user-facing reason when `available === false`. Never contains tokens. */
  hint?: string;
};

/** $FACTORY_HOME or ~/.factory. Never overridden. */
export function resolveDroidHome(): string {
  const fromEnv = process.env.FACTORY_HOME?.trim();
  return fromEnv || join(homedir(), '.factory');
}

/** The auth file the `droid` CLI writes on sign-in. */
export function droidAuthFilePath(): string {
  return join(resolveDroidHome(), 'auth.json');
}

/**
 * Pull the email claim out of a JWT without verifying the signature (we only need
 * an identity label, not trust). Returns undefined on any malformed input.
 */
function emailFromJwt(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined;
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a serialized `auth.json` into identity metadata. Factory's auth blob carries
 * an access/id token (JWT) and may carry a top-level user email. Returns null when
 * the blob carries no usable credential.
 */
export function parseDroidAuthBlob(raw: string): { email?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: {
    access_token?: unknown;
    accessToken?: unknown;
    id_token?: unknown;
    api_key?: unknown;
    user?: { email?: unknown };
    email?: unknown;
  };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const token = parsed.access_token ?? parsed.accessToken ?? parsed.id_token;
  const apiKey = typeof parsed.api_key === 'string' && parsed.api_key.length > 0;
  const hasToken = typeof token === 'string' && token.length > 0;
  if (!hasToken && !apiKey) return null;
  const topLevelEmail =
    typeof parsed.email === 'string'
      ? parsed.email
      : typeof parsed.user?.email === 'string'
        ? parsed.user.email
        : undefined;
  return { email: topLevelEmail ?? emailFromJwt(token) };
}

/**
 * Public entrypoint. Synchronous to match {@link detectCodexAccount}.
 */
export function detectDroidAccount(): DetectDroidAccountResult {
  try {
    const authFile = droidAuthFilePath();
    if (!existsSync(authFile)) {
      return {
        available: false,
        hint: 'No Droid login found. Run `droid` and sign in, then try again.',
      };
    }

    const parsed = parseDroidAuthBlob(readFileSync(authFile, 'utf-8'));
    if (!parsed) {
      return {
        available: false,
        hint: 'Droid credentials are present but unreadable. Sign in again with `droid`.',
      };
    }

    return {
      available: true,
      email: parsed.email,
      displayName: parsed.email ?? 'Factory',
      sourcePath: 'droid-passthrough://local',
    };
  } catch (error) {
    log.error('[detect-droid] detectDroidAccount failed:', sanitizeError(error));
    return {
      available: false,
      hint: 'Failed to read Droid credentials. See logs for details.',
    };
  }
}
