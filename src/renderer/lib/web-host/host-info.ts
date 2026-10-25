/** What the web host injects into index.html: present only when served by Frink's web mode. */

export type WebHostInfo = { platform: string; arch: string; version: string };

let cached: WebHostInfo | null | undefined;

export function readWebHostInfo(doc: Document = document): WebHostInfo | null {
  if (cached !== undefined) return cached;
  const content = doc.querySelector('meta[name="frink-web-host"]')?.getAttribute('content');
  if (!content) {
    cached = null;
    return cached;
  }
  try {
    const value = JSON.parse(decodeURIComponent(content)) as Partial<WebHostInfo>;
    cached = {
      platform: typeof value.platform === 'string' ? value.platform : 'linux',
      arch: typeof value.arch === 'string' ? value.arch : 'unknown',
      version: typeof value.version === 'string' ? value.version : '',
    };
  } catch {
    cached = null;
  }
  return cached;
}

/** True in a browser tab served by web mode (never inside the Electron app). */
export function isWebHost(): boolean {
  return typeof window !== 'undefined' && readWebHostInfo() !== null;
}

export function _resetWebHostInfoForTests(): void {
  cached = undefined;
}
