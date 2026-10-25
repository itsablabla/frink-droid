/* eslint-disable max-lines-per-function */
/**
 * The web mode server: sign-in, the renderer's static files, tRPC over WebSocket, and the desktop
 * bridge socket. Every route except the sign-in page and health check needs a live session, and
 * every socket upgrade needs a live session plus an allowed Origin and Host.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { nodeHTTPRequestHandler } from '@trpc/server/adapters/node-http';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import superjson from 'superjson';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  parseWebHostClientMessage,
  WEB_HOST_API_TRPC_PATH,
  WEB_HOST_BASE_PATH,
  WEB_HOST_HEALTH_PATH,
  WEB_HOST_LOGIN_PATH,
  WEB_HOST_LOGOUT_PATH,
  WEB_HOST_MAX_UPLOAD_BYTES,
  WEB_HOST_SESSION_PATH,
  WEB_HOST_TRPC_PATH,
  WEB_HOST_UPLOAD_PATH,
  WEB_HOST_WS_PATH,
  type WebHostServerMessage,
} from '../../../shared/lib/web-host';
import type { Context } from '../trpc';
import type { createAppRouter } from '../trpc/routers';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  clientKey,
  isAllowedHost,
  isAllowedOrigin,
  LoginThrottle,
  readCookie,
  SessionStore,
  sessionCookieName,
  verifyPassword,
} from './auth';
import { bearerToken, isValidApiKey } from './api-keys';
import { invokeFromTab, releaseTabResources, sendFromTab } from './bridge';
import { isValidTabId, type TabRecord, TabRegistry } from './clients';
import type { WebHostConfig } from './config';
import { FolderAccessError, listFolder } from './folders';
import {
  readBody,
  readIndexHtml,
  redirect,
  sendText,
  serveStatic,
  setSecurityHeaders,
} from './http';
import { LOGIN_PAGE_CSP, renderLoginPage } from './login-page';
import { relayLoopbackCallback } from './oauth-relay';
import { receiveUpload, sweepUploads, UploadError } from './uploads';

const MAX_LOGIN_BODY = 4 * 1024;
const MAX_API_BODY = 8 * 1024 * 1024;
const MAX_WS_PAYLOAD = 64 * 1024 * 1024;

export type WebHostDeps = {
  config: WebHostConfig;
  passwordHash: string;
  rendererDir: string;
  /** Where browser uploads are staged before being copied into a project. */
  uploadDir: string;
  router: ReturnType<typeof createAppRouter>;
  getWindow: () => BrowserWindow | null;
  hostInfo: { platform: string; arch: string; version: string };
  /** Main's per-webContents cleanup (stream delivery ownership) for a tab that went away. */
  onTabGone: (virtualId: number) => void;
};

export type WebHost = { server: Server; tabs: TabRegistry; close: () => Promise<void> };

function requestOrigin(req: IncomingMessage, config: WebHostConfig): string {
  const forwardedProto = config.trustProxy ? req.headers['x-forwarded-proto'] : undefined;
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
    ?.split(',')[0]
    ?.trim();
  const scheme = proto === 'https' || config.secureCookies ? 'https' : 'http';
  return `${scheme}://${req.headers.host ?? 'localhost'}`;
}

function tabIdFrom(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://local');
  const tabId = url.searchParams.get('tab');
  return isValidTabId(tabId) ? tabId : null;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function startWebHost(deps: WebHostDeps): Promise<WebHost> {
  const { config } = deps;
  const sessions = new SessionStore(config.sessionIdleMs, config.sessionMaxMs);
  const throttle = new LoginThrottle();
  const tabs = new TabRegistry();
  const cookieName = sessionCookieName(config);
  const sessionOf = (req: IncomingMessage) => readCookie(req, cookieName);
  const isSignedIn = (req: IncomingMessage) => sessions.touch(sessionOf(req));

  const forgetTab = (tab: TabRecord) => {
    if (!tabs.forgetIfIdle(tab)) return;
    void releaseTabResources(tab);
    deps.onTabGone(tab.virtualId);
  };

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedOrigin(req, config)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    const key = clientKey(req, config);
    if (throttle.retryAfterMs(key) > 0) {
      res.setHeader('Retry-After', String(Math.ceil(throttle.retryAfterMs(key) / 1000)));
      redirect(res, `${WEB_HOST_LOGIN_PATH}?error=wait`);
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_LOGIN_BODY);
    } catch {
      sendText(res, 413, 'Too large');
      return;
    }
    const password = new URLSearchParams(body.toString('utf8')).get('password') ?? '';
    const ok = password.length > 0 && (await verifyPassword(password, deps.passwordHash));
    if (!ok) {
      throttle.recordFailure(key);
      log.warn('[WebHost] Failed sign-in', { client: key });
      redirect(res, `${WEB_HOST_LOGIN_PATH}?error=invalid`);
      return;
    }
    throttle.recordSuccess(key);
    sessions.revoke(sessionOf(req));
    res.setHeader('Set-Cookie', buildSessionCookie(config, sessions.create()));
    log.info('[WebHost] Signed in', { client: key });
    redirect(res, '/');
  }

  function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    if (!isAllowedOrigin(req, config)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    const token = sessionOf(req);
    sessions.revoke(token);
    if (token) tabs.closeSession(token);
    res.setHeader('Set-Cookie', buildClearedSessionCookie(config));
    redirect(res, WEB_HOST_LOGIN_PATH);
  }

  async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!isAllowedOrigin(req, config) || !isSignedIn(req)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    try {
      const path = await receiveUpload(
        req,
        deps.uploadDir,
        url.searchParams.get('name'),
        WEB_HOST_MAX_UPLOAD_BYTES,
      );
      sendText(res, 200, JSON.stringify({ path }), 'application/json; charset=utf-8');
    } catch (error) {
      const status = error instanceof UploadError ? error.status : 500;
      sendText(res, status, error instanceof Error ? error.message : 'Upload failed');
    }
  }

  /** Script access: tRPC over HTTP with a bearer API key. No cookie is read, so no CSRF surface. */
  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const key = clientKey(req, config);
    if (throttle.retryAfterMs(key) > 0) {
      res.setHeader('Retry-After', String(Math.ceil(throttle.retryAfterMs(key) / 1000)));
      sendText(res, 429, 'Too many attempts');
      return;
    }
    if (!isValidApiKey(bearerToken(req), config.apiKeyHashes)) {
      throttle.recordFailure(key);
      log.warn('[WebHost] Refused API request', { client: key });
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendText(res, 401, 'Unauthorized');
      return;
    }
    const path = url.pathname.slice(WEB_HOST_API_TRPC_PATH.length + 1);
    await nodeHTTPRequestHandler({
      req,
      res,
      path,
      router: deps.router,
      createContext: (): Context => ({ getWindow: deps.getWindow }),
      maxBodySize: MAX_API_BODY,
    });
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res, config.secureCookies);
    const url = new URL(req.url ?? '/', 'http://local');
    const { pathname } = url;
    // Platform probes call the container by its internal address; health reveals nothing.
    if (pathname === WEB_HOST_HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      sendText(res, 200, 'ok');
      return;
    }
    if (!isAllowedHost(req, config)) {
      sendText(res, 421, 'Unknown host');
      return;
    }
    if (pathname.startsWith(`${WEB_HOST_API_TRPC_PATH}/`)) return handleApi(req, res, url);
    if (pathname === WEB_HOST_LOGIN_PATH) {
      if (req.method === 'POST') return handleLogin(req, res);
      if (isSignedIn(req)) return redirect(res, '/');
      res.setHeader('Content-Security-Policy', LOGIN_PAGE_CSP);
      sendText(
        res,
        200,
        renderLoginPage(url.searchParams.get('error')),
        'text/html; charset=utf-8',
      );
      return;
    }
    if (pathname === WEB_HOST_LOGOUT_PATH && req.method === 'POST') return handleLogout(req, res);
    if (pathname === WEB_HOST_SESSION_PATH) {
      res.statusCode = isSignedIn(req) ? 204 : 401;
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }
    if (pathname === WEB_HOST_UPLOAD_PATH && req.method === 'POST')
      return handleUpload(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }
    if (!isSignedIn(req)) {
      if (pathname === '/' || pathname === '/index.html') {
        redirect(res, WEB_HOST_LOGIN_PATH);
        return;
      }
      sendText(res, 401, 'Sign in first');
      return;
    }
    if (pathname.startsWith(`${WEB_HOST_BASE_PATH}/`)) {
      sendText(res, 404, 'Not found');
      return;
    }
    if (await serveStatic(req, res, deps.rendererDir, pathname)) return;
    if (pathname.startsWith('/assets/')) {
      sendText(res, 404, 'Not found');
      return;
    }
    const html = await readIndexHtml(deps.rendererDir, requestOrigin(req, config), deps.hostInfo);
    sendText(res, 200, html, 'text/html; charset=utf-8');
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      log.error('[WebHost] Request failed', { error: String(error) });
      if (!res.headersSent) sendText(res, 500, 'Server error');
      else res.end();
    });
  });
  // Uploads may be large; the per-request cap is the upload byte limit, not a clock.
  server.requestTimeout = 30 * 60_000;
  void sweepUploads(deps.uploadDir);
  const sweepTimer = setInterval(() => void sweepUploads(deps.uploadDir), 60 * 60_000);
  sweepTimer.unref();
  server.headersTimeout = 20_000;

  const trpcWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  const socketTab = new WeakMap<WebSocket, TabRecord>();

  const trpcHandler = applyWSSHandler({
    wss: trpcWss,
    router: deps.router,
    keepAlive: { enabled: true, pingMs: 30_000, pongWaitMs: 10_000 },
    createContext: ({ res }): Context => ({
      getWindow: deps.getWindow,
      senderWebContentsId: socketTab.get(res as WebSocket)?.virtualId,
    }),
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const target =
      url.pathname === WEB_HOST_TRPC_PATH
        ? trpcWss
        : url.pathname === WEB_HOST_WS_PATH
          ? bridgeWss
          : null;
    if (!target) return rejectUpgrade(socket, 404, 'Not Found');
    if (!isAllowedHost(req, config) || !isAllowedOrigin(req, config)) {
      log.warn('[WebHost] Refused socket from origin', { origin: req.headers.origin ?? 'none' });
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    const token = sessionOf(req);
    if (!token || !sessions.touch(token)) return rejectUpgrade(socket, 401, 'Unauthorized');
    const tabId = tabIdFrom(req);
    if (!tabId) return rejectUpgrade(socket, 400, 'Bad Request');
    target.handleUpgrade(req, socket, head, (ws) => {
      const tab = tabs.ensure(tabId, token);
      socketTab.set(ws, tab);
      target.emit('connection', ws, req);
    });
  });

  trpcWss.on('connection', (ws: WebSocket) => {
    const tab = socketTab.get(ws);
    if (!tab) return ws.close(1011);
    tab.trpcSockets += 1;
    ws.on('close', () => {
      tab.trpcSockets -= 1;
      forgetTab(tab);
    });
  });

  bridgeWss.on('connection', (ws: WebSocket) => {
    const tab = socketTab.get(ws);
    if (!tab) return ws.close(1011);
    tab.bridge?.close(4409, 'replaced');
    tab.bridge = ws;
    tabs.markActive(tab);
    const send = (message: WebHostServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const answer = (id: number, run: () => Promise<unknown>) => {
      run().then(
        (value) => send({ t: 'result', id, ok: true, value: superjson.serialize(value) }),
        (error: unknown) =>
          send({
            t: 'result',
            id,
            ok: false,
            error:
              error instanceof FolderAccessError || error instanceof Error
                ? error.message
                : 'Failed',
          }),
      );
    };
    send({ t: 'hello', clientId: tab.virtualId });
    ws.on('message', (data) => {
      if (!sessions.touch(tab.sessionToken)) {
        ws.close(4401, 'session expired');
        return;
      }
      const message = parseWebHostClientMessage(data.toString());
      if (!message) return;
      switch (message.t) {
        case 'active':
          tabs.markActive(tab);
          return;
        case 'invoke':
          answer(message.id, () => invokeFromTab(tab, message.ch, message.args));
          return;
        case 'send':
          sendFromTab(tab, message.ch, message.args);
          return;
        case 'fs-list':
          answer(message.id, () => listFolder(config.roots, message.path, message.createChild));
          return;
        case 'oauth-callback':
          answer(message.id, () => relayLoopbackCallback(message.url));
          return;
        case 'reply':
          tabs.reply(tab, message.id, message.value);
          return;
      }
    });
    ws.on('close', () => {
      if (tab.bridge === ws) tab.bridge = null;
      forgetTab(tab);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      log.info('[WebHost] Listening', { host: config.host, port: config.port });
      resolve({
        server,
        tabs,
        close: async () => {
          clearInterval(sweepTimer);
          trpcHandler.broadcastReconnectNotification();
          for (const ws of [...trpcWss.clients, ...bridgeWss.clients]) ws.terminate();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}
