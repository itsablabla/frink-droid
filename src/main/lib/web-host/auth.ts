/**
 * Web mode authentication: one shared password (scrypt), opaque server-side sessions in an
 * HttpOnly SameSite=Strict cookie, per-IP login throttling, and Origin/Host checks.
 * Sessions live in memory: a restart signs everyone out, which is the safe default.
 */
import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebHostConfig } from './config';

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

function scryptAsync(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scrypt(password, salt, KEY_LENGTH, opts, (error, key) =>
      error ? reject(error) : resolvePromise(key),
    );
  });
}

/** `scrypt$N$r$p$salt$hash` for FRINK_WEB_PASSWORD_HASH (see scripts/web/hash-password). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = encoded.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every((value) => Number.isInteger(value) && value > 0)) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), {
    N,
    r: R,
    p: P,
    maxmem: 128 * N * R * 2,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

type Session = { createdAt: number; lastSeenAt: number };

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly idleMs: number,
    private readonly maxMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(): string {
    const token = randomBytes(32).toString('base64url');
    const at = this.now();
    this.sessions.set(token, { createdAt: at, lastSeenAt: at });
    return token;
  }

  /** True (and refreshed) for a live session; expired sessions are dropped. */
  touch(token: string | undefined): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    const at = this.now();
    if (at - session.lastSeenAt > this.idleMs || at - session.createdAt > this.maxMs) {
      this.sessions.delete(token);
      return false;
    }
    session.lastSeenAt = at;
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Fixed-window failure counter per client key, plus a global cap against distributed guessing. */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; windowStart: number }>();
  private globalFailures = { count: 0, windowStart: 0 };

  constructor(
    private readonly perClientLimit = 5,
    private readonly globalLimit = 50,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds the client must wait, or 0 when it may try. */
  retryAfterMs(key: string): number {
    const at = this.now();
    if (at - this.globalFailures.windowStart < this.windowMs) {
      if (this.globalFailures.count >= this.globalLimit) {
        return this.windowMs - (at - this.globalFailures.windowStart);
      }
    }
    const entry = this.failures.get(key);
    if (!entry || at - entry.windowStart >= this.windowMs) return 0;
    return entry.count >= this.perClientLimit ? this.windowMs - (at - entry.windowStart) : 0;
  }

  recordFailure(key: string): void {
    const at = this.now();
    const entry = this.failures.get(key);
    if (!entry || at - entry.windowStart >= this.windowMs) {
      this.failures.set(key, { count: 1, windowStart: at });
    } else {
      entry.count += 1;
    }
    if (at - this.globalFailures.windowStart >= this.windowMs) {
      this.globalFailures = { count: 1, windowStart: at };
    } else {
      this.globalFailures.count += 1;
    }
    if (this.failures.size > 10_000) this.failures.clear();
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}

export function sessionCookieName(config: Pick<WebHostConfig, 'secureCookies'>): string {
  return config.secureCookies ? '__Host-frink_session' : 'frink_session';
}

export function buildSessionCookie(
  config: Pick<WebHostConfig, 'secureCookies' | 'sessionMaxMs'>,
  token: string,
): string {
  const parts = [
    `${sessionCookieName(config)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(config.sessionMaxMs / 1000)}`,
  ];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearedSessionCookie(config: Pick<WebHostConfig, 'secureCookies'>): string {
  const parts = [`${sessionCookieName(config)}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (config.secureCookies) parts.push('Secure');
  parts.push('Max-Age=0');
  return parts.join('; ');
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** Host header must be one we serve (blocks DNS rebinding onto a localhost-bound port). */
export function isAllowedHost(req: IncomingMessage, config: Pick<WebHostConfig, 'allowedHosts'>) {
  const host = req.headers.host?.toLowerCase();
  return Boolean(host && config.allowedHosts.includes(host));
}

/**
 * State-changing requests and socket upgrades must carry an allowed Origin. A missing Origin is
 * refused: every browser sends one on WebSocket upgrades and cross-site form posts.
 */
export function isAllowedOrigin(
  req: IncomingMessage,
  config: Pick<WebHostConfig, 'allowedOrigins'>,
): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && config.allowedOrigins.includes(origin);
}

/**
 * Throttle key: the socket peer, or (behind one trusted proxy) the right-most X-Forwarded-For
 * entry, which that proxy appended. Earlier entries are client-supplied and could be spoofed to
 * dodge the per-client limit.
 */
export function clientKey(req: IncomingMessage, config: Pick<WebHostConfig, 'trustProxy'>) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const joined = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    const last = joined?.split(',').at(-1)?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
