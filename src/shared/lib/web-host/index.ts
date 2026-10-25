/**
 * Web mode wire protocol: the messages a browser tab and the Frink main process exchange over the
 * authenticated `/__frink/ws` WebSocket. Process-agnostic so both ends share one definition.
 *
 * Payload values (`args`, `value`) are superjson-encoded so Dates, Maps, and binary survive the
 * JSON hop exactly as they survive Electron's structured-clone IPC.
 */

export const WEB_HOST_BASE_PATH = '/__frink';
export const WEB_HOST_WS_PATH = `${WEB_HOST_BASE_PATH}/ws`;
/** Standard tRPC WebSocket protocol (`wsLink` ↔ the tRPC ws adapter). */
export const WEB_HOST_TRPC_PATH = `${WEB_HOST_BASE_PATH}/trpc`;
export const WEB_HOST_LOGIN_PATH = `${WEB_HOST_BASE_PATH}/login`;
export const WEB_HOST_LOGOUT_PATH = `${WEB_HOST_BASE_PATH}/logout`;
export const WEB_HOST_UPLOAD_PATH = `${WEB_HOST_BASE_PATH}/upload`;
export const WEB_HOST_HEALTH_PATH = `${WEB_HOST_BASE_PATH}/health`;
/** tRPC over plain HTTP for scripts, authorised by `Authorization: Bearer <API key>`. */
export const WEB_HOST_API_TRPC_PATH = `${WEB_HOST_BASE_PATH}/api/trpc`;
/** 204 while the session cookie is live, 401 otherwise (a tab checks this after a disconnect). */
export const WEB_HOST_SESSION_PATH = `${WEB_HOST_BASE_PATH}/session`;
export const WEB_HOST_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** `desktopApi` invoke channels a browser tab may call in main. Anything else is refused. */
export const WEB_HOST_INVOKE_CHANNELS = [
  'analytics:set-opt-out',
  'app:isPackaged',
  'app:version',
  'git:subscribe-watcher',
  'git:unsubscribe-watcher',
] as const;

/** Fire-and-forget channels a browser tab may emit to main listeners (permission responses). */
export const WEB_HOST_SEND_CHANNELS = [
  'agent:move-chat-response',
  'permission:response',
  'socket:permission-response',
] as const;

/**
 * One-shot pushes that make a renderer act (enqueue and send a prompt). Delivered to a single
 * "leader" tab so two open tabs never double-send the same dispatch.
 */
export const WEB_HOST_LEADER_ONLY_CHANNELS = ['task:chat-ready'] as const;

export type WebHostInvokeChannel = (typeof WEB_HOST_INVOKE_CHANNELS)[number];
export type WebHostSendChannel = (typeof WEB_HOST_SEND_CHANNELS)[number];

export type WebHostDirectoryEntry = { name: string; path: string };
export type WebHostDirectoryListing = {
  path: string;
  parent: string | null;
  roots: string[];
  entries: WebHostDirectoryEntry[];
};

/** Server → tab requests that need a person (the desktop dialogs and browser launches). */
export type WebHostServerRequest =
  | { kind: 'pick-folder'; title: string; defaultPath?: string }
  | { kind: 'open-external'; url: string };

export type WebHostClientMessage =
  | { t: 'invoke'; id: number; ch: string; args: unknown }
  | { t: 'send'; ch: string; args: unknown }
  | { t: 'fs-list'; id: number; path?: string; createChild?: string }
  | { t: 'reply'; id: number; value: unknown }
  | { t: 'oauth-callback'; id: number; url: string }
  | { t: 'active' };

export type WebHostServerMessage =
  | { t: 'hello'; clientId: number }
  | { t: 'push'; ch: string; args: unknown }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'request'; id: number; request: WebHostServerRequest }
  | { t: 'cancel-request'; id: number };

/** Hosts an OAuth redirect may point at for the in-container callback relay. */
export function isLoopbackCallbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** Parse a client frame; null for anything that is not one of the known message shapes. */
export function parseWebHostClientMessage(raw: string): WebHostClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  const hasId = Number.isSafeInteger(message.id);
  switch (message.t) {
    case 'invoke':
      return hasId && typeof message.ch === 'string'
        ? { t: 'invoke', id: message.id as number, ch: message.ch, args: message.args }
        : null;
    case 'send':
      return typeof message.ch === 'string'
        ? { t: 'send', ch: message.ch, args: message.args }
        : null;
    case 'fs-list':
      if (!hasId) return null;
      return {
        t: 'fs-list',
        id: message.id as number,
        ...(typeof message.path === 'string' ? { path: message.path } : {}),
        ...(typeof message.createChild === 'string' ? { createChild: message.createChild } : {}),
      };
    case 'reply':
      return hasId ? { t: 'reply', id: message.id as number, value: message.value } : null;
    case 'oauth-callback':
      return hasId && typeof message.url === 'string'
        ? { t: 'oauth-callback', id: message.id as number, url: message.url }
        : null;
    case 'active':
      return { t: 'active' };
    default:
      return null;
  }
}
