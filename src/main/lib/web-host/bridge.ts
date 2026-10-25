/**
 * The Electron side of web mode: the seams that let browser tabs stand in for BrowserWindows.
 *
 * - IPC capture: `ipcMain.handle` registrations are recorded so an allow-listed browser `invoke`
 *   can reach the same handler; `.on` listeners are reached with `ipcMain.emit`.
 * - Push fan-out: everything main sends to the hidden host window is relayed to every tab.
 * - Person-facing desktop calls (folder dialog, opening a browser) are forwarded to a tab.
 */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, shell } from 'electron';
import log from 'electron-log';
import superjson from 'superjson';
import {
  WEB_HOST_INVOKE_CHANNELS,
  WEB_HOST_LEADER_ONLY_CHANNELS,
  WEB_HOST_SEND_CHANNELS,
} from '../../../shared/lib/web-host';
import { isAllowedShellOpenExternalUrl } from '../../../shared/shell-external-url';
import type { TabRecord, TabRegistry } from './clients';
import { resolveInsideRoots } from './folders';

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const capturedHandlers = new Map<string, InvokeHandler>();
let captureInstalled = false;

/** Must run before any `ipcMain.handle` registration (top of main/index.ts). */
export function installIpcCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalRemove = ipcMain.removeHandler.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    capturedHandlers.set(channel, listener as InvokeHandler);
    return originalHandle(channel, listener);
  };
  ipcMain.removeHandler = (channel) => {
    capturedHandlers.delete(channel);
    return originalRemove(channel);
  };
}

/** A stand-in for Electron's IPC event, scoped to one browser tab. */
function tabEvent(tab: TabRecord) {
  const sender = {
    id: tab.virtualId,
    isDestroyed: () => tab.bridge === null,
    send: () => undefined,
    getZoomFactor: () => 1,
  };
  return { sender, senderFrame: null, returnValue: undefined, reply: () => undefined };
}

const INVOKE_ALLOWED = new Set<string>(WEB_HOST_INVOKE_CHANNELS);
const SEND_ALLOWED = new Set<string>(WEB_HOST_SEND_CHANNELS);
const LEADER_ONLY = new Set<string>(WEB_HOST_LEADER_ONLY_CHANNELS);
/** Events about the hidden host window itself; each tab reports its own focus and fullscreen. */
const HOST_WINDOW_ONLY = new Set(['window:focus-change', 'window:fullscreen-change']);

function asArgs(raw: unknown): unknown[] {
  if (raw === undefined || raw === null) return [];
  const value = superjson.deserialize(raw as Parameters<typeof superjson.deserialize>[0]);
  return Array.isArray(value) ? value : [];
}

function trackGitSubscription(tab: TabRecord, channel: string, args: unknown[]): void {
  const path = typeof args[0] === 'string' ? args[0] : null;
  if (!path) return;
  const count = tab.gitSubscriptions.get(path) ?? 0;
  if (channel === 'git:subscribe-watcher') tab.gitSubscriptions.set(path, count + 1);
  else if (count <= 1) tab.gitSubscriptions.delete(path);
  else tab.gitSubscriptions.set(path, count - 1);
}

export async function invokeFromTab(
  tab: TabRecord,
  channel: string,
  rawArgs: unknown,
): Promise<unknown> {
  if (!INVOKE_ALLOWED.has(channel))
    throw new Error(`Channel not available in web mode: ${channel}`);
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  const args = asArgs(rawArgs);
  const result = await handler(tabEvent(tab) as unknown as IpcMainInvokeEvent, ...args);
  if (channel.startsWith('git:')) trackGitSubscription(tab, channel, args);
  return result;
}

export function sendFromTab(tab: TabRecord, channel: string, rawArgs: unknown): void {
  if (!SEND_ALLOWED.has(channel)) {
    log.warn('[WebHost] Refused send on channel', { channel });
    return;
  }
  ipcMain.emit(channel, tabEvent(tab), ...asArgs(rawArgs));
}

/** Release what a vanished tab still held (git watchers), as a closed window would. */
export async function releaseTabResources(tab: TabRecord): Promise<void> {
  const unsubscribe = capturedHandlers.get('git:unsubscribe-watcher');
  for (const [path, count] of tab.gitSubscriptions) {
    for (let index = 0; index < count; index += 1) {
      await Promise.resolve(
        unsubscribe?.(tabEvent(tab) as unknown as IpcMainInvokeEvent, path),
      ).catch(() => undefined);
    }
  }
  tab.gitSubscriptions.clear();
}

/** Relay every `webContents.send` on the hidden host window to the browser tabs. */
export function attachHostWindowFanOut(window: BrowserWindow, tabs: TabRegistry): void {
  const contents = window.webContents;
  const originalSend = contents.send.bind(contents);
  contents.send = (channel: string, ...args: unknown[]) => {
    try {
      if (LEADER_ONLY.has(channel)) tabs.pushToLeader(channel, args);
      else if (!HOST_WINDOW_ONLY.has(channel)) tabs.broadcast(channel, args);
    } catch (error) {
      log.warn('[WebHost] Push fan-out failed', { channel, error: String(error) });
    }
    originalSend(channel, ...args);
  };
}

type OpenDialogOptions = Electron.OpenDialogOptions;

function dialogOptions(args: unknown[]): OpenDialogOptions {
  const last = args[args.length - 1];
  return last && typeof last === 'object' && !(last instanceof BrowserWindow)
    ? (last as OpenDialogOptions)
    : {};
}

/** Route the desktop folder dialog and browser launches to the person in the active tab. */
export function patchDesktopIntegrations(tabs: TabRegistry, roots: string[]): void {
  dialog.showOpenDialog = (async (...args: unknown[]) => {
    const options = dialogOptions(args);
    if (!options.properties?.includes('openDirectory')) {
      return { canceled: true, filePaths: [] };
    }
    const picked = await tabs.request({
      kind: 'pick-folder',
      title: options.title ?? 'Select Folder',
      ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
    });
    if (typeof picked !== 'string') return { canceled: true, filePaths: [] };
    try {
      return { canceled: false, filePaths: [await resolveInsideRoots(roots, picked)] };
    } catch (error) {
      log.warn('[WebHost] Refused picked folder', { error: String(error) });
      return { canceled: true, filePaths: [] };
    }
  }) as typeof dialog.showOpenDialog;

  shell.openExternal = async (url: string) => {
    if (!isAllowedShellOpenExternalUrl(url)) throw new Error('blocked_url');
    const opened = await tabs.request({ kind: 'open-external', url });
    if (opened === null) log.warn('[WebHost] No browser tab to open a link in');
  };
  shell.openPath = async () => 'Opening files is not available in web mode';
  shell.showItemInFolder = () => undefined;
}
