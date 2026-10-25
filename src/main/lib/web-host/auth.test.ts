import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  clientKey,
  hashPassword,
  isAllowedHost,
  isAllowedOrigin,
  LoginThrottle,
  readCookie,
  SessionStore,
  verifyPassword,
} from './auth';

function req(headers: Record<string, string | string[]>, remoteAddress = '10.0.0.9') {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const encoded = await hashPassword('correct horse battery');
    expect(encoded).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', encoded)).toBe(true);
    expect(await verifyPassword('correct horse batterz', encoded)).toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPassword('same password!')).not.toBe(await hashPassword('same password!'));
  });

  it('rejects malformed hashes without throwing', async () => {
    expect(await verifyPassword('x', 'bcrypt$1$2$3$a$b')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$abc$8$1$a$b')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});

describe('SessionStore', () => {
  it('expires idle and over-age sessions', () => {
    let now = 0;
    const store = new SessionStore(100, 1_000, () => now);
    const token = store.create();
    expect(token.length).toBeGreaterThanOrEqual(40);
    now = 90;
    expect(store.touch(token)).toBe(true);
    now = 180; // 90ms since last touch: still within idle
    expect(store.touch(token)).toBe(true);
    now = 300; // idle 120ms
    expect(store.touch(token)).toBe(false);
    expect(store.size).toBe(0);

    const kept = store.create();
    for (now = 300; now <= 1_300; now += 50) store.touch(kept);
    expect(store.touch(kept)).toBe(false); // max age 1000ms reached
  });

  it('revokes and rejects unknown tokens', () => {
    const store = new SessionStore(1_000, 1_000);
    const token = store.create();
    store.revoke(token);
    expect(store.touch(token)).toBe(false);
    expect(store.touch(undefined)).toBe(false);
    expect(store.touch('guess')).toBe(false);
  });
});

describe('LoginThrottle', () => {
  it('locks a client after the per-client limit and resets after the window', () => {
    let now = 0;
    const throttle = new LoginThrottle(3, 100, 1_000, () => now);
    for (let i = 0; i < 3; i++) throttle.recordFailure('a');
    expect(throttle.retryAfterMs('a')).toBe(1_000);
    expect(throttle.retryAfterMs('b')).toBe(0);
    now = 1_000;
    expect(throttle.retryAfterMs('a')).toBe(0);
  });

  it('applies a global cap across clients', () => {
    const throttle = new LoginThrottle(5, 4, 1_000, () => 0);
    for (const key of ['a', 'b', 'c', 'd']) throttle.recordFailure(key);
    expect(throttle.retryAfterMs('fresh')).toBeGreaterThan(0);
  });

  it('clears a client on success', () => {
    const throttle = new LoginThrottle(2, 100, 1_000, () => 0);
    throttle.recordFailure('a');
    throttle.recordFailure('a');
    throttle.recordSuccess('a');
    expect(throttle.retryAfterMs('a')).toBe(0);
  });
});

describe('cookies', () => {
  const base = { sessionMaxMs: 30_000 };
  it('uses a __Host- Secure cookie when secure', () => {
    const cookie = buildSessionCookie({ ...base, secureCookies: true }, 'tok');
    expect(cookie).toBe(
      '__Host-frink_session=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=30; Secure',
    );
    expect(buildClearedSessionCookie({ secureCookies: true })).toContain('Max-Age=0');
  });

  it('is HttpOnly SameSite=Strict without Secure on plain http', () => {
    const cookie = buildSessionCookie({ ...base, secureCookies: false }, 'tok');
    expect(cookie.startsWith('frink_session=tok;')).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');
  });

  it('reads one cookie by exact name', () => {
    const request = req({ cookie: 'xfrink_session=bad; frink_session=good; other=1' });
    expect(readCookie(request, 'frink_session')).toBe('good');
    expect(readCookie(req({}), 'frink_session')).toBeUndefined();
  });
});

describe('host and origin checks', () => {
  const config = {
    allowedHosts: ['frink.example.com'],
    allowedOrigins: ['https://frink.example.com'],
  };
  it('refuses foreign Host headers (DNS rebinding)', () => {
    expect(isAllowedHost(req({ host: 'frink.example.com' }), config)).toBe(true);
    expect(isAllowedHost(req({ host: 'FRINK.example.com' }), config)).toBe(true);
    expect(isAllowedHost(req({ host: 'evil.example' }), config)).toBe(false);
    expect(isAllowedHost(req({}), config)).toBe(false);
  });

  it('requires an exact allowed Origin and refuses a missing one', () => {
    expect(isAllowedOrigin(req({ origin: 'https://frink.example.com' }), config)).toBe(true);
    expect(isAllowedOrigin(req({ origin: 'http://frink.example.com' }), config)).toBe(false);
    expect(isAllowedOrigin(req({ origin: 'https://frink.example.com.evil' }), config)).toBe(false);
    expect(isAllowedOrigin(req({ origin: 'null' }), config)).toBe(false);
    expect(isAllowedOrigin(req({}), config)).toBe(false);
  });
});

describe('clientKey', () => {
  it('uses the socket peer unless a proxy is trusted', () => {
    expect(clientKey(req({ 'x-forwarded-for': '1.1.1.1' }), { trustProxy: false })).toBe(
      '10.0.0.9',
    );
  });

  it('uses the proxy-appended (right-most) hop so clients cannot spoof the key', () => {
    const request = req({ 'x-forwarded-for': 'spoofed, 203.0.113.7' });
    expect(clientKey(request, { trustProxy: true })).toBe('203.0.113.7');
  });
});
