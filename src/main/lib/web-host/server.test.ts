/**
 * The web host's security boundary, end to end over real HTTP and WebSocket connections: sign-in,
 * throttling, session gating of pages/sockets/uploads, Origin and Host checks, and sign-out.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), emit: vi.fn() },
  shell: {},
}));
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { hashPassword } = await import('./auth');
const { generateApiKey, hashApiKey } = await import('./api-keys');
const { startWebHost } = await import('./server');
const { readWebHostConfig } = await import('./config');
const { createAppRouter } = await import('../trpc/routers');

const PASSWORD = 'a long test password';
const API_KEY = generateApiKey();
let base: string;
let origin: string;
let host: Awaited<ReturnType<typeof startWebHost>>;

async function startHost() {
  const config = readWebHostConfig({
    FRINK_WEB_PORT: '1',
    FRINK_WEB_HOST: '127.0.0.1',
    FRINK_WEB_PASSWORD: PASSWORD,
    FRINK_WEB_ROOTS: join(base, 'workspace'),
    FRINK_WEB_API_KEY_HASHES: hashApiKey(API_KEY),
  });
  if (!config) throw new Error('config');
  // Bind an ephemeral port; allowedOrigins/Hosts are rebuilt for it below.
  config.port = 0;
  const started = await startWebHost({
    config,
    passwordHash: await hashPassword(PASSWORD),
    rendererDir: join(base, 'renderer'),
    uploadDir: join(base, 'uploads'),
    router: createAppRouter(() => null),
    getWindow: () => null,
    hostInfo: { platform: 'linux', arch: 'arm64', version: '0.4.0' },
    onTabGone: () => {},
  });
  const { port } = started.server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  config.allowedOrigins.push(origin);
  config.allowedHosts.push(`127.0.0.1:${port}`);
  return started;
}

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...headers },
    body,
  });
}

async function signIn(): Promise<string> {
  const res = await post('/__frink/login', `password=${encodeURIComponent(PASSWORD)}`);
  expect(res.status).toBe(303);
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}

function openSocket(path: string, headers: Record<string, string>): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}${path}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'frink-server-'));
  await mkdir(join(base, 'workspace'));
  await mkdir(join(base, 'renderer', 'assets'), { recursive: true });
  await writeFile(
    join(base, 'renderer', 'index.html'),
    `<html><head><meta http-equiv="Content-Security-Policy" content="connect-src 'self'"></head><body>APP</body></html>`,
  );
  await writeFile(join(base, 'renderer', 'assets', 'app.js'), 'console.log(1)');
  await writeFile(join(base, 'secret.txt'), 'SECRET');
  host = await startHost();
});

afterAll(async () => {
  await host?.close();
  await rm(base, { recursive: true, force: true });
});

describe('web host security', () => {
  it('serves health and the sign-in page without a session, with security headers', async () => {
    expect(await (await fetch(`${origin}/__frink/health`)).text()).toBe('ok');
    const login = await fetch(`${origin}/__frink/login`);
    expect(login.status).toBe(200);
    expect(login.headers.get('x-frame-options')).toBe('DENY');
    expect(login.headers.get('x-content-type-options')).toBe('nosniff');
    expect(login.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    // no-referrer would make Chrome send `Origin: null` on the sign-in form post (refused).
    expect(login.headers.get('referrer-policy')).toBe('same-origin');
    expect(await login.text()).not.toContain('content="no-referrer"');
  });

  it('keeps the app and its assets behind sign-in', async () => {
    const root = await fetch(`${origin}/`, { redirect: 'manual' });
    expect(root.status).toBe(303);
    expect(root.headers.get('location')).toBe('/__frink/login');
    expect((await fetch(`${origin}/assets/app.js`)).status).toBe(401);
    expect((await fetch(`${origin}/__frink/session`)).status).toBe(401);
  });

  async function statusWithHost(path: string, host: string): Promise<number> {
    const { request } = await import('node:http');
    return new Promise<number>((resolve) => {
      const url = new URL(origin);
      request({ host: url.hostname, port: url.port, path, headers: { Host: host } }, (res) =>
        resolve(res.statusCode ?? 0),
      ).end();
    });
  }

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    expect(await statusWithHost('/', 'evil.test')).toBe(421);
    expect(await statusWithHost('/__frink/login', 'evil.test')).toBe(421);
    expect(await statusWithHost('/__frink/session', 'evil.test')).toBe(421);
  });

  it('answers the health probe on any Host (platform probes use an internal address)', async () => {
    expect(await statusWithHost('/__frink/health', '10.0.0.7:8080')).toBe(200);
  });

  it('rejects a wrong password and a cross-site sign-in post', async () => {
    const wrong = await post('/__frink/login', 'password=nope', { 'X-Forwarded-For': '9.9.9.1' });
    expect(wrong.headers.get('location')).toBe('/__frink/login?error=invalid');
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const crossSite = await post('/__frink/login', `password=${PASSWORD}`, {
      Origin: 'https://evil.test',
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get('set-cookie')).toBeNull();
  });

  it('signs in with an HttpOnly SameSite=Strict cookie and serves the app', async () => {
    const res = await post('/__frink/login', `password=${encodeURIComponent(PASSWORD)}`);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    const cookie = setCookie.split(';')[0] ?? '';
    const app = await fetch(`${origin}/`, { headers: { Cookie: cookie } });
    const html = await app.text();
    expect(html).toContain('APP');
    expect(html).toContain('name="frink-web-host"');
    expect(html).toContain(`connect-src 'self' ${origin.replace('http', 'ws')}`);
    expect((await fetch(`${origin}/__frink/session`, { headers: { Cookie: cookie } })).status).toBe(
      204,
    );
  });

  it('never serves files outside the renderer build', async () => {
    const cookie = await signIn();
    for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await fetch(`${origin}${path}`, { headers: { Cookie: cookie } });
      expect(await res.text()).not.toContain('SECRET');
    }
  });

  it('gates socket upgrades on session, Origin and tab id', async () => {
    const cookie = await signIn();
    const tab = '?tab=test-tab-0001';
    expect(await openSocket(`/__frink/ws${tab}`, { Origin: origin })).toBe(401);
    expect(
      await openSocket(`/__frink/ws${tab}`, { Origin: 'https://evil.test', Cookie: cookie }),
    ).toBe(403);
    expect(await openSocket(`/__frink/trpc${tab}`, { Cookie: cookie })).toBe(403);
    expect(await openSocket('/__frink/ws?tab=bad', { Origin: origin, Cookie: cookie })).toBe(400);
    expect(await openSocket(`/__frink/ws${tab}`, { Origin: origin, Cookie: cookie })).toBe('open');
    expect(await openSocket(`/__frink/trpc${tab}`, { Origin: origin, Cookie: cookie })).toBe(
      'open',
    );
  });

  it('only accepts uploads from a signed-in, same-origin page', async () => {
    const cookie = await signIn();
    const upload = (headers: Record<string, string>) =>
      fetch(`${origin}/__frink/upload?name=a.txt`, { method: 'POST', headers, body: 'data' });
    expect((await upload({ Origin: origin })).status).toBe(403);
    expect((await upload({ Origin: 'https://evil.test', Cookie: cookie })).status).toBe(403);
    const ok = await upload({ Origin: origin, Cookie: cookie });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { path: string }).path).toContain(join(base, 'uploads'));
  });

  it('signs out: the old cookie stops working', async () => {
    const cookie = await signIn();
    const out = await post('/__frink/logout', '', { Cookie: cookie });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(`${origin}/__frink/session`, { headers: { Cookie: cookie } })).status).toBe(
      401,
    );
  });

  it('throttles repeated wrong passwords from one client', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) last = await post('/__frink/login', 'password=wrong');
    expect(last?.headers.get('location')).toBe('/__frink/login?error=wait');
  });

  it('lets scripts call tRPC over HTTP only with a valid API key, never with the session cookie', async () => {
    // A fresh host: the throttling test above has already locked this client out.
    await host.close();
    host = await startHost();
    const api = (headers: Record<string, string>) =>
      fetch(`${origin}/__frink/api/trpc/no.such.procedure`, { headers });
    expect((await api({})).status).toBe(401);
    expect((await api({ Authorization: 'Bearer frk_wrong' })).status).toBe(401);
    expect((await api({ Authorization: `Bearer ${generateApiKey()}` })).status).toBe(401);
    expect((await api({ Cookie: await signIn() })).status).toBe(401);
    // A valid key reaches the router: an unknown procedure is tRPC's own 404, not the gate's 401.
    const ok = await api({ Authorization: `Bearer ${API_KEY}` });
    expect(ok.status).toBe(404);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });
});
