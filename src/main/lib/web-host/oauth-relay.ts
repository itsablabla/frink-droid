/**
 * OAuth loopback relay. Desktop sign-in flows listen on `http://localhost:<port>/callback`
 * inside the container, which the person's browser cannot reach. After the provider redirects
 * the browser to that (dead) loopback URL, the person pastes it into Frink and the tab sends it
 * here; main replays it against the in-container callback server so the flow completes unchanged.
 */
import { request } from 'node:http';
import { isLoopbackCallbackUrl } from '../../../shared/lib/web-host';

export type RelayResult = { ok: true; status: number } | { ok: false; error: string };

export function relayLoopbackCallback(rawUrl: string, timeoutMs = 15_000): Promise<RelayResult> {
  if (!isLoopbackCallbackUrl(rawUrl)) {
    return Promise.resolve({ ok: false, error: 'Paste the full http://localhost/... address.' });
  }
  const url = new URL(rawUrl);
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Host: url.host },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode ?? 0 });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'The sign-in callback did not answer.' });
    });
    req.on('error', () =>
      resolve({ ok: false, error: 'No sign-in is waiting for that address. Start it again.' }),
    );
    req.end();
  });
}
