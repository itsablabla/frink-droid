/**
 * Person-facing requests in web mode: main asks a tab to pick a folder or open a link. React UI
 * (WebHostDialogs) subscribes and renders them; until it mounts, requests wait in the queue.
 */
import type { WebHostServerRequest } from '../../../shared/lib/web-host';

export type PendingWebRequest = {
  key: number;
  request: WebHostServerRequest;
  resolve: (value: unknown) => void;
};

type Listener = (requests: PendingWebRequest[]) => void;

class WebHostRequests {
  private queue: PendingWebRequest[] = [];
  private readonly listeners = new Set<Listener>();
  private nextKey = 1;
  private readonly byServerId = new Map<number, PendingWebRequest>();

  private emit(): void {
    for (const listener of this.listeners) listener(this.queue);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.queue);
    return () => this.listeners.delete(listener);
  }

  private enqueue(request: WebHostServerRequest, serverId?: number): Promise<unknown> {
    return new Promise((resolve) => {
      const pending: PendingWebRequest = {
        key: this.nextKey++,
        request,
        resolve: (value) => {
          this.queue = this.queue.filter((item) => item !== pending);
          if (serverId !== undefined) this.byServerId.delete(serverId);
          this.emit();
          resolve(value);
        },
      };
      if (serverId !== undefined) this.byServerId.set(serverId, pending);
      this.queue = [...this.queue, pending];
      this.emit();
    });
  }

  /** A request from main. Links open directly when the browser allows it (user gesture). */
  handle(request: WebHostServerRequest, serverId?: number): Promise<unknown> {
    if (request.kind === 'open-external' && tryOpen(request.url)) return Promise.resolve(true);
    return this.enqueue(request, serverId);
  }

  /** Main gave up on a request (timeout, or another tab answered). */
  cancel(serverId: number): void {
    this.byServerId.get(serverId)?.resolve(null);
  }

  /** `desktopApi.openExternal` from this tab's own UI. */
  openExternal(url: string): Promise<{ success: true } | { success: false; error: 'blocked_url' }> {
    if (!isSafeExternalUrl(url)) return Promise.resolve({ success: false, error: 'blocked_url' });
    if (tryOpen(url)) return Promise.resolve({ success: true });
    return this.enqueue({ kind: 'open-external', url }).then(() => ({ success: true }));
  }
}

export function isSafeExternalUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw.trim()).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * Open in a new tab; false when the popup blocker refused (no recent user gesture). `noopener`
 * would make window.open always return null, so the opener link is cut by hand instead.
 */
function tryOpen(url: string): boolean {
  if (!isSafeExternalUrl(url)) return false;
  const opened = window.open('about:blank', '_blank');
  if (!opened) return false;
  opened.opener = null;
  opened.location.href = url;
  return true;
}

export const webHostRequests = new WebHostRequests();
