/**
 * The browser tab's desktop bridge: one authenticated WebSocket to main that carries invokes,
 * fire-and-forget sends, server pushes, and person-facing requests. Reconnects with backoff and
 * sends to the sign-in page when the session is gone.
 */
import superjson from 'superjson';
import {
  WEB_HOST_LOGIN_PATH,
  WEB_HOST_SESSION_PATH,
  WEB_HOST_WS_PATH,
  type WebHostServerMessage,
  type WebHostServerRequest,
} from '../../../shared/lib/web-host';

type PushListener = (event: unknown, ...args: unknown[]) => void;
type RequestHandler = (request: WebHostServerRequest, id: number) => Promise<unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const TAB_ID_KEY = 'frink:web-tab-id';
const MAX_BACKOFF_MS = 10_000;

export function getTabId(storage: Storage = sessionStorage): string {
  const existing = storage.getItem(TAB_ID_KEY);
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const id = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  storage.setItem(TAB_ID_KEY, id);
  return id;
}

export function socketUrl(path: string, tabId: string, location: Location = window.location) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${path}?tab=${encodeURIComponent(tabId)}`;
}

export class BridgeSocket {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<string, Set<PushListener>>();
  private readonly pending = new Map<number, Pending>();
  private readonly outbox: string[] = [];
  private nextId = 1;
  private attempt = 0;
  private requestHandler: RequestHandler | null = null;
  private readonly cancelHandlers = new Map<number, () => void>();
  private readonly statusListeners = new Set<(connected: boolean) => void>();

  constructor(private readonly tabId: string) {}

  connect(): void {
    const socket = new WebSocket(socketUrl(WEB_HOST_WS_PATH, this.tabId));
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      for (const listener of this.statusListeners) listener(true);
      for (const frame of this.outbox.splice(0)) socket.send(frame);
    };
    socket.onmessage = (event) => this.handle(String(event.data));
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const listener of this.statusListeners) listener(false);
      for (const pending of this.pending.values()) pending.reject(new Error('Disconnected'));
      this.pending.clear();
      if (event.code === 4409) return; // a newer socket for this tab took over
      void this.reconnectOrSignIn();
    };
  }

  private async reconnectOrSignIn(): Promise<void> {
    try {
      const response = await fetch(WEB_HOST_SESSION_PATH, { credentials: 'same-origin' });
      if (response.status === 401) {
        window.location.assign(`${WEB_HOST_LOGIN_PATH}?error=expired`);
        return;
      }
    } catch {
      // Server unreachable: keep retrying.
    }
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    this.attempt += 1;
    setTimeout(() => this.connect(), delay);
  }

  /** Connection up/down notifications; returns an unsubscribe function. */
  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onRequest(handler: RequestHandler, onCancel: (id: number) => void): void {
    this.requestHandler = handler;
    this.cancelRequest = onCancel;
  }

  private cancelRequest: (id: number) => void = () => undefined;

  private post(message: Record<string, unknown>): void {
    const frame = JSON.stringify(message);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
    else this.outbox.push(frame);
  }

  private call(message: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ ...message, id });
    });
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return this.call({ t: 'invoke', ch: channel, args: superjson.serialize(args) });
  }

  send(channel: string, ...args: unknown[]): void {
    this.post({ t: 'send', ch: channel, args: superjson.serialize(args) });
  }

  listFolder(path?: string, createChild?: string): Promise<unknown> {
    return this.call({
      t: 'fs-list',
      ...(path ? { path } : {}),
      ...(createChild ? { createChild } : {}),
    });
  }

  relayOAuthCallback(url: string): Promise<unknown> {
    return this.call({ t: 'oauth-callback', url });
  }

  markActive(): void {
    this.post({ t: 'active' });
  }

  on(channel: string, listener: PushListener): void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
  }

  /** Deliver a push that originates in this tab (its own focus/fullscreen changes). */
  emitLocal(channel: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) listener({ sender: null }, ...args);
  }

  removeListener(channel: string, listener: PushListener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  private handle(raw: string): void {
    let message: WebHostServerMessage;
    try {
      message = JSON.parse(raw) as WebHostServerMessage;
    } catch {
      return;
    }
    switch (message.t) {
      case 'push': {
        const args = superjson.deserialize(message.args as never) as unknown[];
        for (const listener of this.listeners.get(message.ch) ?? []) {
          try {
            listener({ sender: null }, ...(Array.isArray(args) ? args : []));
          } catch (error) {
            // One failing listener must not starve the others; surface it asynchronously.
            queueMicrotask(() => {
              throw error;
            });
          }
        }
        return;
      }
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(superjson.deserialize(message.value as never));
        else pending.reject(new Error(message.error));
        return;
      }
      case 'request': {
        const handler = this.requestHandler;
        const id = message.id;
        if (!handler) {
          this.post({ t: 'reply', id, value: null });
          return;
        }
        handler(message.request, id).then(
          (value) => this.post({ t: 'reply', id, value: value ?? null }),
          () => this.post({ t: 'reply', id, value: null }),
        );
        return;
      }
      case 'cancel-request':
        this.cancelRequest(message.id);
        return;
      case 'hello':
        return;
    }
  }
}
