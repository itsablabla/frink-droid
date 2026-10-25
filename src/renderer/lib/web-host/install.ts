/**
 * Web mode bootstrap. In a normal browser (no Electron preload) this installs the same globals the
 * preload exposes: `window.desktopApi` (shared factory over the bridge socket) and `webUtils`.
 * Must run before any module reads `window.desktopApi` (first import of main.tsx).
 */
import { createDesktopApi, type DesktopIpc } from '../../../shared/lib/desktop-api';
import { BridgeSocket, getTabId } from './bridge-socket';
import { createWebArtifactPreview } from './artifact-preview';
import { webHostRequests } from './requests';
import { readWebHostInfo, isWebHost } from './host-info';

export { isWebHost } from './host-info';

let bridge: BridgeSocket | null = null;

/** The bridge socket, once {@link installWebHost} ran (web mode only). */
export function getWebBridge(): BridgeSocket | null {
  return bridge;
}

/** Channels answered in the browser itself; everything else goes to main over the bridge. */
function localInvoke(channel: string, args: unknown[]): Promise<unknown> | undefined {
  const info = readWebHostInfo();
  switch (channel) {
    case 'shell:open-external':
      return webHostRequests.openExternal(String(args[0] ?? ''));
    case 'clipboard:write':
      return navigator.clipboard.writeText(String(args[0] ?? '')).then(() => undefined);
    case 'clipboard:read':
      return navigator.clipboard.readText().catch(() => '');
    case 'app:show-notification':
      return showNotification(args[0] as { title: string; body: string } | undefined);
    case 'app:set-badge': {
      const count = typeof args[0] === 'number' ? args[0] : 0;
      document.title = count > 0 ? `Frink (${count})` : 'Frink';
      return Promise.resolve();
    }
    case 'window:toggle-fullscreen':
      return document.fullscreenElement
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen().catch(() => undefined);
    case 'window:is-fullscreen':
      return Promise.resolve(Boolean(document.fullscreenElement));
    case 'window:get-frame-state':
    case 'window:is-maximized':
      return Promise.resolve(false);
    case 'window:get-zoom':
      return Promise.resolve(1);
    case 'app:version':
      return info ? Promise.resolve(info.version) : undefined;
    case 'app:set-badge-icon':
    case 'window:minimize':
    case 'window:maximize':
    case 'window:close':
    case 'window:set-frame-preference':
    case 'window:zoom-in':
    case 'window:zoom-out':
    case 'window:zoom-reset':
    case 'window:toggle-devtools':
    case 'window:unlock-devtools':
    case 'update:check':
    case 'update:download':
    case 'update:install':
      // Browser chrome owns window/zoom/devtools; a web server updates by redeploying its image.
      return Promise.resolve(undefined);
    default:
      return undefined;
  }
}

async function showNotification(options: { title: string; body: string } | undefined) {
  if (!options || typeof Notification === 'undefined' || !document.hidden) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return;
  const notification = new Notification(options.title, { body: options.body });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

function createWebIpc(socket: BridgeSocket): DesktopIpc {
  const ipc = {
    invoke: (channel: string, ...args: unknown[]) =>
      localInvoke(channel, args) ?? socket.invoke(channel, ...args),
    send: (channel: string, ...args: unknown[]) => socket.send(channel, ...args),
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      socket.on(channel, listener);
      return ipc;
    },
    removeListener: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
      socket.removeListener(channel, listener);
      return ipc;
    },
  };
  return ipc as unknown as DesktopIpc;
}

function reportFocusAndFullscreen(socket: BridgeSocket): void {
  const markActive = () => socket.markActive();
  window.addEventListener('focus', markActive);
  document.addEventListener('pointerdown', markActive, { capture: true, passive: true });
  document.addEventListener('keydown', markActive, { capture: true, passive: true });
  const emit = (channel: string, value: boolean) => {
    socket.emitLocal(channel, value);
  };
  window.addEventListener('focus', () => emit('window:focus-change', true));
  window.addEventListener('blur', () => emit('window:focus-change', false));
  document.addEventListener('fullscreenchange', () =>
    emit('window:fullscreen-change', Boolean(document.fullscreenElement)),
  );
}

/** Install the browser globals; a no-op inside Electron (the preload already did it). */
export function installWebHost(): void {
  if (!isWebHost() || window.desktopApi) return;
  const info = readWebHostInfo();
  const socket = new BridgeSocket(getTabId());
  bridge = socket;
  socket.onRequest(
    (request, id) => webHostRequests.handle(request, id),
    (id) => webHostRequests.cancel(id),
  );
  socket.connect();
  const ipc = createWebIpc(socket);
  const artifactPreview = createWebArtifactPreview();
  window.desktopApi = createDesktopApi(ipc, {
    platform: (info?.platform ?? 'linux') as NodeJS.Platform,
    arch: info?.arch ?? 'unknown',
    artifactPreview,
  }) as typeof window.desktopApi;
  // A browser File has no server path; drops upload first (see uploads.ts).
  window.webUtils = { getPathForFile: () => '' };
  reportFocusAndFullscreen(socket);
}
