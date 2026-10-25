/**
 * Web mode configuration, read once from the environment. Web mode is off unless FRINK_WEB_PORT
 * is set; when it is on, a password (or its scrypt hash) is mandatory: there is no open mode.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type WebHostConfig = {
  port: number;
  host: string;
  /** `scrypt$N$r$p$saltB64$hashB64`, or a plain password hashed at startup. */
  password: { kind: 'hash'; value: string } | { kind: 'plain'; value: string };
  /** Exact origins (scheme://host[:port]) allowed to open sockets and post forms. */
  allowedOrigins: string[];
  /** Host header values accepted (anti DNS-rebinding). Derived from allowedOrigins. */
  allowedHosts: string[];
  /** Folders the browser folder picker may show and pick from. */
  roots: string[];
  /** Honour X-Forwarded-For / X-Forwarded-Proto from a TLS-terminating reverse proxy. */
  trustProxy: boolean;
  /** Mark the session cookie Secure (`__Host-` prefix). Required on the public internet. */
  secureCookies: boolean;
  sessionIdleMs: number;
  sessionMaxMs: number;
};

export const MIN_PASSWORD_LENGTH = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

export class WebHostConfigError extends Error {}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebHostConfigError(`FRINK_WEB_ORIGINS has an invalid origin: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebHostConfigError(`FRINK_WEB_ORIGINS must be http(s): ${raw}`);
  }
  return url.origin;
}

function defaultOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

function readPassword(env: NodeJS.ProcessEnv): WebHostConfig['password'] {
  const hash = env.FRINK_WEB_PASSWORD_HASH?.trim();
  if (hash) {
    if (!/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(hash)) {
      throw new WebHostConfigError('FRINK_WEB_PASSWORD_HASH is not a scrypt$N$r$p$salt$hash');
    }
    return { kind: 'hash', value: hash };
  }
  const plain = env.FRINK_WEB_PASSWORD ?? '';
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw new WebHostConfigError(
      `Web mode needs FRINK_WEB_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) or FRINK_WEB_PASSWORD_HASH`,
    );
  }
  return { kind: 'plain', value: plain };
}

function readFlag(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/** Null when web mode is off (no FRINK_WEB_PORT). Throws on a half-configured web mode. */
export function readWebHostConfig(env: NodeJS.ProcessEnv = process.env): WebHostConfig | null {
  const rawPort = env.FRINK_WEB_PORT?.trim();
  if (!rawPort) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new WebHostConfigError(`FRINK_WEB_PORT is not a valid port: ${rawPort}`);
  }
  const configuredOrigins = parseList(env.FRINK_WEB_ORIGINS).map(normalizeOrigin);
  const allowedOrigins = [...new Set([...configuredOrigins, ...defaultOrigins(port)])];
  const roots = parseList(env.FRINK_WEB_ROOTS?.replaceAll(':', ','));
  return {
    port,
    host: env.FRINK_WEB_HOST?.trim() || '0.0.0.0',
    password: readPassword(env),
    allowedOrigins,
    allowedHosts: allowedOrigins.map((origin) => new URL(origin).host),
    roots: (roots.length > 0 ? roots : [homedir()]).map((root) => resolve(root)),
    trustProxy: readFlag(env.FRINK_WEB_TRUST_PROXY),
    secureCookies: readFlag(env.FRINK_WEB_SECURE_COOKIES),
    sessionIdleMs: 7 * DAY_MS,
    sessionMaxMs: 30 * DAY_MS,
  };
}

/** Cheap check for call sites that only need to know whether web mode is on. */
export function isWebModeRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.FRINK_WEB_PORT?.trim());
}
