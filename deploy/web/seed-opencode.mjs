// Seeds OpenCode model providers from FRINK_WEB_OPENCODE_PROVIDERS at container start.
//
// Input (JSON): { "model": "id/model", "providers": { "<id>": { name, baseURL, models, apiKey } } }
// Writes ~/.frink/opencode/providers.json (no keys; Frink adds these providers to each OpenCode
// launch) and each apiKey into OpenCode's own sign-in store, for OpenCode 1.19 and 2. Other
// sign-ins already in the store are kept. Nothing is printed except errors without values.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const home = process.env.HOME;
const raw = process.env.FRINK_WEB_OPENCODE_PROVIDERS;
if (!home || !raw) process.exit(0);

function fail(message) {
  console.error(`frink-web: FRINK_WEB_OPENCODE_PROVIDERS ${message}`);
  process.exit(64);
}

let input;
try {
  input = JSON.parse(raw);
} catch {
  fail('is not valid JSON');
}
const entries = Object.entries(input?.providers ?? {});
if (entries.length === 0) fail('has no providers');

function writePrivate(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

const providers = {};
const keys = {};
for (const [id, { apiKey, ...provider }] of entries) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) fail(`provider ${id} has no apiKey`);
  providers[id] = provider;
  keys[id] = { type: 'api', key: apiKey };
}

const config = { providers, ...(input.model ? { model: input.model } : {}) };
writePrivate(path.join(home, '.frink', 'opencode', 'providers.json'), config);

const stores = [
  path.join(home, '.local', 'share', 'opencode', 'auth.json'), // OpenCode 1.19
  path.join(home, '.frink', 'opencode', 'data', 'opencode', 'auth.json'), // OpenCode 2 under Frink
];
for (const store of stores) {
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(store, 'utf8'));
  } catch {}
  writePrivate(store, { ...existing, ...keys });
}
console.error(`frink-web: seeded ${entries.length} OpenCode provider(s)`);
