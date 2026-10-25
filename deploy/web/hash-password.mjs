#!/usr/bin/env node
// Print FRINK_WEB_PASSWORD_HASH for the password read from stdin (same scrypt format as
// src/main/lib/web-host/auth.ts). Use the hash in deployments so the container never holds the
// plain password, which processes inside it (agents, terminals) could otherwise read.
//   printf '%s' "$PASSWORD" | node deploy/web/hash-password.mjs
import { randomBytes, scryptSync } from 'node:crypto';

const N = 1 << 15;
const r = 8;
const p = 1;
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
if (password.length < 12) {
  console.error('Password must be at least 12 characters');
  process.exit(1);
}
const salt = randomBytes(16);
const key = scryptSync(password, salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
process.stdout.write(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}\n`);
