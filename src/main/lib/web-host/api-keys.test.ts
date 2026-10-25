import { describe, expect, it } from 'vitest';
import {
  ApiKeyConfigError,
  bearerToken,
  generateApiKey,
  hashApiKey,
  isValidApiKey,
  parseApiKeyHashes,
} from './api-keys';

const req = (authorization?: string) =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as never;

describe('web host API keys', () => {
  it('generates unique, well-formed keys whose hash matches', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toMatch(/^frk_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isValidApiKey(a, [hashApiKey(b), hashApiKey(a)])).toBe(true);
    expect(isValidApiKey(b, [hashApiKey(a)])).toBe(false);
  });

  it('refuses missing, malformed and unconfigured keys', () => {
    const key = generateApiKey();
    expect(isValidApiKey(undefined, [hashApiKey(key)])).toBe(false);
    expect(isValidApiKey(key, [])).toBe(false);
    expect(isValidApiKey(`${key}x`, [hashApiKey(`${key}x`)])).toBe(false);
  });

  it('reads only Bearer authorization headers', () => {
    expect(bearerToken(req('Bearer abc'))).toBe('abc');
    expect(bearerToken(req('bearer  abc '))).toBe('abc');
    expect(bearerToken(req('Basic abc'))).toBeUndefined();
    expect(bearerToken(req())).toBeUndefined();
  });

  it('parses configured hashes and rejects anything else', () => {
    const h = hashApiKey(generateApiKey());
    expect(parseApiKeyHashes(`${h.toUpperCase()}, ${h}`)).toEqual([h]);
    expect(parseApiKeyHashes(undefined)).toEqual([]);
    expect(() => parseApiKeyHashes('frk_plainkey')).toThrow(ApiKeyConfigError);
  });
});
