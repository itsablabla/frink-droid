/**
 * API keys for scripts: `Authorization: Bearer frk_…` on the HTTP tRPC endpoint. The server keeps
 * only each key's SHA-256 (a key is 32 random bytes, so a fast hash is enough) and compares in
 * constant time. A key grants what a signed-in tab can do, so treat it like the password.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const API_KEY_PREFIX = 'frk_';
const KEY_PATTERN = /^frk_[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class ApiKeyConfigError extends Error {}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** `FRINK_WEB_API_KEY_HASHES`: comma or space separated SHA-256 hex digests. */
export function parseApiKeyHashes(raw: string | undefined): string[] {
  const hashes = (raw ?? '')
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  for (const hash of hashes) {
    if (!HASH_PATTERN.test(hash)) {
      throw new ApiKeyConfigError('FRINK_WEB_API_KEY_HASHES must hold SHA-256 hex digests');
    }
  }
  return [...new Set(hashes)];
}

/** The bearer token on a request, or undefined when it carries none. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** True when `key` is well formed and matches one of `hashes`. */
export function isValidApiKey(key: string | undefined, hashes: readonly string[]): boolean {
  if (!key || hashes.length === 0 || !KEY_PATTERN.test(key)) return false;
  const candidate = Buffer.from(hashApiKey(key), 'hex');
  let found = false;
  // Compare against every hash so timing does not reveal which (or whether an early) one matched.
  for (const hash of hashes) {
    if (timingSafeEqual(candidate, Buffer.from(hash, 'hex'))) found = true;
  }
  return found;
}
