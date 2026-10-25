import { describe, expect, it } from 'vitest';
import { isWebModeRequested, readWebHostConfig, WebHostConfigError } from './config';

const password = 'twelve chars!';

describe('readWebHostConfig', () => {
  it('is off without FRINK_WEB_PORT', () => {
    expect(readWebHostConfig({})).toBeNull();
    expect(isWebModeRequested({})).toBe(false);
    expect(isWebModeRequested({ FRINK_WEB_PORT: '8080' })).toBe(true);
  });

  it('refuses to start without a strong enough password', () => {
    expect(() => readWebHostConfig({ FRINK_WEB_PORT: '8080' })).toThrow(WebHostConfigError);
    expect(() =>
      readWebHostConfig({ FRINK_WEB_PORT: '8080', FRINK_WEB_PASSWORD: 'short' }),
    ).toThrow(/at least 12/);
  });

  it('accepts a well-formed hash and rejects a malformed one', () => {
    const hash = 'scrypt$32768$8$1$c2FsdA==$aGFzaA==';
    expect(
      readWebHostConfig({ FRINK_WEB_PORT: '8080', FRINK_WEB_PASSWORD_HASH: hash })?.password,
    ).toEqual({ kind: 'hash', value: hash });
    expect(() =>
      readWebHostConfig({ FRINK_WEB_PORT: '8080', FRINK_WEB_PASSWORD_HASH: 'plain' }),
    ).toThrow(WebHostConfigError);
  });

  it('rejects invalid ports and origins', () => {
    expect(() => readWebHostConfig({ FRINK_WEB_PORT: '0', FRINK_WEB_PASSWORD: password })).toThrow(
      /port/,
    );
    expect(() =>
      readWebHostConfig({
        FRINK_WEB_PORT: '8080',
        FRINK_WEB_PASSWORD: password,
        FRINK_WEB_ORIGINS: 'ftp://x',
      }),
    ).toThrow(/http/);
  });

  it('derives origins, hosts, roots and flags', () => {
    const config = readWebHostConfig({
      FRINK_WEB_PORT: '3010',
      FRINK_WEB_PASSWORD: password,
      FRINK_WEB_ORIGINS: 'https://frink.example.com/, http://frink.orb.local:3010',
      FRINK_WEB_ROOTS: '/workspace:/data',
      FRINK_WEB_TRUST_PROXY: 'true',
      FRINK_WEB_SECURE_COOKIES: '1',
    });
    expect(config?.allowedOrigins).toEqual([
      'https://frink.example.com',
      'http://frink.orb.local:3010',
      'http://localhost:3010',
      'http://127.0.0.1:3010',
    ]);
    expect(config?.allowedHosts).toContain('frink.example.com');
    expect(config?.allowedHosts).toContain('localhost:3010');
    expect(config?.roots).toEqual(['/workspace', '/data']);
    expect(config?.trustProxy).toBe(true);
    expect(config?.secureCookies).toBe(true);
    expect(config?.host).toBe('0.0.0.0');
  });
});
