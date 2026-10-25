import { createTRPCProxyClient, createWSClient, type TRPCLink, wsLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import superjson from 'superjson';
import { ipcLink } from 'trpc-electron/renderer';
import type { AppRouter } from '../../main/lib/trpc/routers';
import { WEB_HOST_TRPC_PATH } from '../../shared/lib/web-host';
import { getTabId, socketUrl } from './web-host/bridge-socket';
import { isWebHost } from './web-host/host-info';

/**
 * React hooks for tRPC
 */
export const trpc = createTRPCReact<AppRouter>();

/** Electron IPC inside the desktop app; the authenticated tRPC WebSocket in web mode. */
function transportLink(): TRPCLink<AppRouter> {
  if (!isWebHost()) return ipcLink({ transformer: superjson });
  const client = createWSClient({
    url: () => socketUrl(WEB_HOST_TRPC_PATH, getTabId()),
    retryDelayMs: (attempt) => Math.min(10_000, 500 * 2 ** attempt),
    keepAlive: { enabled: true, intervalMs: 20_000, pongTimeoutMs: 10_000 },
  });
  return wsLink<AppRouter>({ client, transformer: superjson });
}

/**
 * Vanilla client for use outside React components (stores, utilities)
 */
export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [transportLink()],
});

// Expose trpcClient on window for console debugging (dev only)
if (typeof window !== 'undefined') {
  (window as unknown as { trpc: typeof trpcClient }).trpc = trpcClient;
}
