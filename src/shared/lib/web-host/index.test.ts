import { describe, expect, it } from 'vitest';
import { isLoopbackCallbackUrl, parseWebHostClientMessage } from './index';

describe('parseWebHostClientMessage', () => {
  it('parses known frames', () => {
    expect(parseWebHostClientMessage('{"t":"invoke","id":1,"ch":"app:version","args":[]}')).toEqual(
      { t: 'invoke', id: 1, ch: 'app:version', args: [] },
    );
    expect(parseWebHostClientMessage('{"t":"fs-list","id":2,"path":"/w"}')).toEqual({
      t: 'fs-list',
      id: 2,
      path: '/w',
    });
    expect(parseWebHostClientMessage('{"t":"active"}')).toEqual({ t: 'active' });
  });

  it('refuses malformed frames', () => {
    for (const raw of [
      'not json',
      'null',
      '[]',
      '{"t":"invoke","ch":"x"}',
      '{"t":"invoke","id":"1","ch":"x"}',
      '{"t":"invoke","id":1.5,"ch":"x"}',
      '{"t":"send"}',
      '{"t":"oauth-callback","id":1}',
      '{"t":"eval","code":"x"}',
    ]) {
      expect(parseWebHostClientMessage(raw)).toBeNull();
    }
  });

  it('drops non-string optional fields', () => {
    expect(parseWebHostClientMessage('{"t":"fs-list","id":3,"path":{"x":1}}')).toEqual({
      t: 'fs-list',
      id: 3,
    });
  });
});

describe('isLoopbackCallbackUrl', () => {
  it('accepts only plain-http loopback callbacks', () => {
    expect(isLoopbackCallbackUrl('http://localhost:8914/callback?code=1')).toBe(true);
    expect(isLoopbackCallbackUrl('http://127.0.0.1:3000/cb')).toBe(true);
    expect(isLoopbackCallbackUrl('https://localhost/cb')).toBe(false);
    expect(isLoopbackCallbackUrl('http://localhost.evil.com/cb')).toBe(false);
    expect(isLoopbackCallbackUrl('http://169.254.169.254/latest')).toBe(false);
    expect(isLoopbackCallbackUrl('file:///etc/passwd')).toBe(false);
    expect(isLoopbackCallbackUrl('garbage')).toBe(false);
  });
});
