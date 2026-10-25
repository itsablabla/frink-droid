/** HTTP plumbing for web mode: security headers, static renderer files, small body reader. */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

export function setSecurityHeaders(res: ServerResponse, secure: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // same-origin, not no-referrer: Chrome sends `Origin: null` on form posts under no-referrer,
  // which the Origin check (correctly) refuses.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), geolocation=(), payment=(), usb=(), microphone=(self), clipboard-write=(self)',
  );
  // Restricts only what the renderer's own meta CSP cannot express (frame-ancestors).
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'");
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/** Read a request body up to `limit` bytes; rejects (and the caller answers 413) beyond it. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The renderer index.html with a CSP that also allows this origin's WebSocket endpoints. */
export async function readIndexHtml(
  rendererDir: string,
  origin: string,
  hostInfo: { platform: string; arch: string },
): Promise<string> {
  const html = await readFile(join(rendererDir, 'index.html'), 'utf8');
  const wsOrigin = origin.replace(/^http/, 'ws');
  const meta = `<meta name="frink-web-host" content="${encodeURIComponent(JSON.stringify(hostInfo))}" />`;
  return html
    .replace("connect-src 'self'", `connect-src 'self' ${wsOrigin}`)
    .replace('<head>', `<head>\n    ${meta}`);
}

/**
 * Serve a file from the renderer build. Hashed assets are immutable; everything else revalidates.
 * Returns false when the path is not a file inside `rendererDir` (caller falls back to index).
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  rendererDir: string,
  pathname: string,
): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('\0')) return false;
  const root = resolve(rendererDir);
  const target = resolve(root, `.${normalize(`/${decoded}`)}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return false;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    return false;
  }
  if (!info.isFile() || target.endsWith(`${sep}index.html`)) return false;
  res.statusCode = 200;
  res.setHeader(
    'Content-Type',
    MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
  );
  res.setHeader('Content-Length', String(info.size));
  res.setHeader(
    'Cache-Control',
    decoded.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'no-cache',
  );
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(target).pipe(res);
  return true;
}
