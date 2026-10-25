/**
 * Web mode: serve the full Frink UI to ordinary browsers instead of (well, beside) a desktop window.
 *
 * Enabled by FRINK_WEB_PORT. Main then keeps one hidden "host" BrowserWindow on a blank page as the
 * anchor every window-scoped code path expects, relays all of its pushes to browser tabs, and runs
 * an authenticated HTTP + WebSocket server carrying tRPC and the desktop bridge.
 */
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import log from 'electron-log';
import { releaseExecutionOwnershipForWebContents } from '../socket/streaming/execution-registry';
import { releaseLiveStreamOwnershipForWebContents } from '../socket/streaming/live-stream';
import { createAppRouter } from '../trpc/routers';
import { hashPassword } from './auth';
import { attachHostWindowFanOut, installIpcCapture, patchDesktopIntegrations } from './bridge';
import type { TabRegistry } from './clients';
import { isWebModeRequested, readWebHostConfig } from './config';
import { startWebHost, type WebHost } from './server';

export { isWebModeRequested } from './config';
export { hashPassword } from './auth';

/** The page the hidden host window loads in web mode: it must never run a second renderer. */
export const WEB_HOST_WINDOW_URL = 'about:blank';

let host: WebHost | null = null;
let pendingTabs: TabRegistry | null = null;

/** Call at the very top of main, before any IPC handler or window exists. */
export function prepareWebMode(): void {
  if (!isWebModeRequested()) return;
  installIpcCapture();
  // A headless server has no GPU and no one to show a crash dialog to.
  app.disableHardwareAcceleration();
}

/** Start the server once the database is ready; throws (and main exits) on bad configuration. */
export async function startWebMode(getWindow: () => BrowserWindow | null): Promise<void> {
  const config = readWebHostConfig();
  if (!config) return;
  // Agents, terminals and hooks inherit main's environment: never hand them the sign-in secret.
  delete process.env.FRINK_WEB_PASSWORD;
  delete process.env.FRINK_WEB_PASSWORD_HASH;
  const passwordHash =
    config.password.kind === 'hash'
      ? config.password.value
      : await hashPassword(config.password.value);
  host = await startWebHost({
    config,
    passwordHash,
    rendererDir: join(__dirname, '../renderer'),
    uploadDir: join(app.getPath('userData'), 'web-uploads'),
    router: createAppRouter(getWindow),
    getWindow,
    hostInfo: { platform: process.platform, arch: process.arch, version: app.getVersion() },
    onTabGone: (virtualId) => {
      releaseExecutionOwnershipForWebContents(virtualId);
      releaseLiveStreamOwnershipForWebContents(virtualId);
    },
  });
  pendingTabs = host.tabs;
  patchDesktopIntegrations(host.tabs, config.roots);
  const window = getWindow();
  if (window) attachHostWindowFanOut(window, host.tabs);
  log.info('[WebHost] Web mode ready', {
    origins: config.allowedOrigins,
    roots: config.roots,
    secureCookies: config.secureCookies,
  });
}

/** Relay a (re)created host window's pushes to the browser tabs. */
export function attachWebHostWindow(window: BrowserWindow): void {
  if (pendingTabs) attachHostWindowFanOut(window, pendingTabs);
}

export async function stopWebMode(): Promise<void> {
  const current = host;
  host = null;
  pendingTabs = null;
  await current?.close().catch(() => undefined);
}
