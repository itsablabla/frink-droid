import { readFile } from 'node:fs/promises';
import path from 'node:path';
import log from 'electron-log';
import { z } from 'zod';
import { frinkUserHome } from '../../../platform/frink-home';

/**
 * Extra model providers for OpenCode, such as an OpenAI-compatible gateway, that Frink adds to
 * each launch's settings. Launches refuse any setting Frink did not write, so a provider defined
 * in OpenCode's own config would stop it starting; this file is how one is added instead.
 *
 * The file holds no keys. Each provider's key is read from OpenCode's own sign-in store
 * (`opencode auth login`), keyed by the provider id, like any other sign-in.
 */
const ProviderId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

const Provider = z.strictObject({
  name: z.string().min(1).max(80),
  baseURL: z.url({ protocol: /^https$/ }),
  models: z.array(z.string().min(1).max(200)).min(1).max(50),
});

const ProvidersFile = z.strictObject({
  providers: z.record(ProviderId, Provider),
  /** The model new chats start on, as `provider/model`. */
  model: z.string().optional(),
});

type OpenCodeProvider = {
  npm: string;
  name: string;
  options: { baseURL: string };
  models: Record<string, { name: string; tool_call: boolean }>;
};

export type OpenCodeProviders = {
  provider?: Record<string, OpenCodeProvider>;
  model?: string;
};

export function providersFile(): string {
  return path.join(frinkUserHome(), '.frink', 'opencode', 'providers.json');
}

export function promptFile(): string {
  return path.join(frinkUserHome(), '.frink', 'opencode', 'prompt.md');
}

const MAX_PROMPT_LENGTH = 32_000;

/**
 * The system prompt to use instead of OpenCode's built-in one, which tells models to answer in a
 * few words. Undefined (OpenCode's own) when the file is absent, empty, or too long.
 */
export async function openCodePrompt(file = promptFile()): Promise<string | undefined> {
  let text: string;
  try {
    text = (await readFile(file, 'utf8')).trim();
  } catch {
    return undefined;
  }
  if (text.length === 0) return undefined;
  if (text.length > MAX_PROMPT_LENGTH) {
    log.warn('[ACP] Ignoring OpenCode prompt file over the length limit', file);
    return undefined;
  }
  return text;
}

/** The settings to add for the configured providers; none when the file is absent or invalid. */
export async function openCodeProviders(file = providersFile()): Promise<OpenCodeProviders> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return {};
  }
  let parsed: z.infer<typeof ProvidersFile>;
  try {
    parsed = ProvidersFile.parse(JSON.parse(text));
  } catch (error) {
    // The file holds no keys, but only the error's kind is logged, matching the settings checks.
    log.warn('[ACP] Ignoring invalid OpenCode providers file', file, (error as Error).name);
    return {};
  }
  const entries = Object.entries(parsed.providers);
  if (entries.length === 0) return {};
  const provider: Record<string, OpenCodeProvider> = Object.fromEntries(
    entries.map(([id, { name, baseURL, models }]) => [
      id,
      {
        npm: '@ai-sdk/openai-compatible',
        name,
        options: { baseURL },
        models: Object.fromEntries(
          models.map((model) => [model, { name: model, tool_call: true }]),
        ),
      },
    ]),
  );
  const [providerId, model] = parsed.model?.split(/\/(.*)/s) ?? [];
  const known = providerId !== undefined && parsed.providers[providerId]?.models.includes(model);
  return known ? { provider, model: parsed.model } : { provider };
}
