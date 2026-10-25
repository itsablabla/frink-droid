import { mkdir, mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { receiveUpload, safeUploadName, sweepUploads, UploadError } from './uploads';

let root: string;

function body(data: string, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(data)]), { headers }) as IncomingMessage;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'frink-uploads-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('safeUploadName', () => {
  it('keeps only a plain base name', () => {
    expect(safeUploadName('report.pdf')).toBe('report.pdf');
    expect(safeUploadName('../../etc/passwd')).toBe('passwd');
    for (const bad of [null, '', '..', '.', 'a\\b', 'x'.repeat(256)]) {
      expect(() => safeUploadName(bad)).toThrow(UploadError);
    }
  });
});

describe('receiveUpload', () => {
  it('stores the body in its own random folder under the root', async () => {
    const path = await receiveUpload(body('hello'), root, 'a.txt', 100);
    expect(dirname(dirname(path))).toBe(root);
    expect(await readFile(path, 'utf8')).toBe('hello');
  });

  it('rejects an oversized declared length before writing', async () => {
    await expect(
      receiveUpload(body('x', { 'content-length': '101' }), root, 'a.txt', 100),
    ).rejects.toMatchObject({ status: 413 });
    expect(await readdir(root)).toEqual([]);
  });

  it('aborts and cleans up when the streamed body exceeds the limit', async () => {
    await expect(receiveUpload(body('x'.repeat(101)), root, 'a.txt', 100)).rejects.toMatchObject({
      status: 413,
    });
    expect(await readdir(root)).toEqual([]);
  });
});

describe('sweepUploads', () => {
  it('removes folders older than a day and keeps fresh ones', async () => {
    await mkdir(join(root, 'old'));
    await mkdir(join(root, 'fresh'));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(join(root, 'old'), twoDaysAgo, twoDaysAgo);
    await sweepUploads(root);
    expect(await readdir(root)).toEqual(['fresh']);
  });

  it('ignores a missing root', async () => {
    await expect(sweepUploads(join(root, 'missing'))).resolves.toBeUndefined();
  });
});
