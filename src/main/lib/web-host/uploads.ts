/**
 * Browser file uploads. A dropped browser File has no server path, so the tab first streams it
 * here; the returned server path then goes through the same `files.copyExternalFiles` mutation a
 * desktop drop uses. Each upload lands in its own random folder under userData, swept after a day.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const UNSAFE_NAME = /[/\\\0]/;

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function safeUploadName(raw: string | null): string {
  const name = basename((raw ?? '').trim());
  if (!name || name === '.' || name === '..' || UNSAFE_NAME.test(name) || name.length > 255) {
    throw new UploadError('Invalid file name', 400);
  }
  return name;
}

/** Stream the request body to `<root>/<random>/<name>`; returns the server path. */
export async function receiveUpload(
  req: IncomingMessage,
  root: string,
  rawName: string | null,
  maxBytes: number,
): Promise<string> {
  const name = safeUploadName(rawName);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new UploadError('File too large', 413);
  const dir = join(root, randomBytes(12).toString('hex'));
  await mkdir(dir, { recursive: true });
  const target = join(dir, name);
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new UploadError('File too large', 413));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, createWriteStream(target, { flags: 'wx' }));
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error instanceof UploadError ? error : new UploadError('Upload failed', 400);
  }
  return target;
}

/** Delete upload folders older than a day. */
export async function sweepUploads(root: string, now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      const dir = join(root, name);
      const info = await stat(dir).catch(() => null);
      if (info && now - info.mtimeMs > UPLOAD_TTL_MS)
        await rm(dir, { recursive: true, force: true });
    }),
  );
}
