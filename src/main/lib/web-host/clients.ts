/**
 * Browser tab registry for web mode. Each tab has a stable tab id (sessionStorage) and is given a
 * "virtual webContents id" so main's per-window ownership (stream delivery owner, file-operation
 * progress target) works per tab exactly as it does per BrowserWindow. Virtual ids start far above
 * any real webContents id so they can never collide with the hidden host window.
 */
import superjson from 'superjson';
import type { WebHostServerMessage, WebHostServerRequest } from '../../../shared/lib/web-host';

export const VIRTUAL_WEB_CONTENTS_ID_BASE = 1_000_000;
const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export type BridgeSocket = {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  readonly readyState: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  tab: TabRecord;
};

export type TabRecord = {
  tabId: string;
  virtualId: number;
  bridge: BridgeSocket | null;
  trpcSockets: number;
  lastActiveAt: number;
  sessionToken: string;
  /** git:subscribe-watcher refcounts this tab still holds, released when it goes away. */
  gitSubscriptions: Map<string, number>;
};

export function isValidTabId(value: unknown): value is string {
  return typeof value === 'string' && TAB_ID_PATTERN.test(value);
}

const OPEN = 1;

export class TabRegistry {
  private readonly tabs = new Map<string, TabRecord>();
  private readonly byVirtualId = new Map<number, TabRecord>();
  private readonly pending = new Map<number, PendingRequest>();
  private nextVirtualId = VIRTUAL_WEB_CONTENTS_ID_BASE;
  private nextRequestId = 1;

  constructor(private readonly now: () => number = Date.now) {}

  /** The tab record for `tabId`, created on first sight (same tab id → same virtual id). */
  ensure(tabId: string, sessionToken: string): TabRecord {
    const existing = this.tabs.get(tabId);
    if (existing) {
      existing.sessionToken = sessionToken;
      return existing;
    }
    this.nextVirtualId += 1;
    const tab: TabRecord = {
      tabId,
      virtualId: this.nextVirtualId,
      bridge: null,
      trpcSockets: 0,
      lastActiveAt: this.now(),
      sessionToken,
      gitSubscriptions: new Map(),
    };
    this.tabs.set(tabId, tab);
    this.byVirtualId.set(tab.virtualId, tab);
    return tab;
  }

  byVirtual(virtualId: number | undefined): TabRecord | undefined {
    return virtualId === undefined ? undefined : this.byVirtualId.get(virtualId);
  }

  markActive(tab: TabRecord): void {
    tab.lastActiveAt = this.now();
  }

  /** Drop a tab once it has no sockets left; returns true when it was removed. */
  forgetIfIdle(tab: TabRecord): boolean {
    if (tab.bridge || tab.trpcSockets > 0) return false;
    this.tabs.delete(tab.tabId);
    this.byVirtualId.delete(tab.virtualId);
    for (const [id, request] of this.pending) {
      if (request.tab === tab) this.settle(id, null);
    }
    return true;
  }

  connectedTabs(): TabRecord[] {
    return [...this.tabs.values()].filter((tab) => tab.bridge && tab.bridge.readyState === OPEN);
  }

  /** The most recently active connected tab: where a person-facing request should appear. */
  activeTab(preferred?: TabRecord): TabRecord | undefined {
    if (preferred?.bridge && preferred.bridge.readyState === OPEN) return preferred;
    return this.connectedTabs().sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  }

  sendTo(tab: TabRecord, message: WebHostServerMessage): boolean {
    if (!tab.bridge || tab.bridge.readyState !== OPEN) return false;
    tab.bridge.send(JSON.stringify(message));
    return true;
  }

  /** Push an Electron-style `webContents.send(channel, ...args)` to every connected tab. */
  broadcast(channel: string, args: unknown[]): number {
    const frame = JSON.stringify({
      t: 'push',
      ch: channel,
      args: superjson.serialize(args),
    } satisfies WebHostServerMessage);
    let delivered = 0;
    for (const tab of this.connectedTabs()) {
      tab.bridge?.send(frame);
      delivered += 1;
    }
    return delivered;
  }

  /** Push only to the active tab (one-shot pushes that make a renderer act). */
  pushToLeader(channel: string, args: unknown[]): boolean {
    const tab = this.activeTab();
    if (!tab) return false;
    return this.sendTo(tab, { t: 'push', ch: channel, args: superjson.serialize(args) });
  }

  /** Ask a person in a tab; resolves with their reply, or null when nobody can answer. */
  request(request: WebHostServerRequest, preferred?: TabRecord): Promise<unknown> {
    const tab = this.activeTab(preferred);
    if (!tab) return Promise.resolve(null);
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, null), REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer, tab });
      if (!this.sendTo(tab, { t: 'request', id, request })) this.settle(id, null);
    });
  }

  /** A tab's reply to {@link request}; ignored unless that same tab was asked. */
  reply(tab: TabRecord, id: number, value: unknown): void {
    const pending = this.pending.get(id);
    if (!pending || pending.tab !== tab) return;
    this.settle(id, value);
  }

  private settle(id: number, value: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    this.sendTo(pending.tab, { t: 'cancel-request', id });
    pending.resolve(value);
  }

  /** Close every socket that belongs to a revoked session. */
  closeSession(sessionToken: string): void {
    for (const tab of this.tabs.values()) {
      if (tab.sessionToken === sessionToken) tab.bridge?.close(4401, 'signed out');
    }
  }
}
