import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  maskMcpHeaders,
  openCodeMcpServers,
  openCodePrompt,
  openCodeProviders,
} from './opencode-providers';

vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }));

const GATEWAY = {
  name: 'Garza Auto',
  baseURL: 'https://app.manifest.build/v1',
  models: ['auto'],
};

describe('OpenCode providers file', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'oc-providers-'));
    file = path.join(dir, 'providers.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const write = (value: unknown) => writeFile(file, JSON.stringify(value));

  it('adds nothing when there is no file', async () => {
    expect(await openCodeProviders(file)).toEqual({});
  });

  it('turns each provider into an OpenAI-compatible one, with no key', async () => {
    await write({ providers: { 'garza-auto': GATEWAY }, model: 'garza-auto/auto' });
    expect(await openCodeProviders(file)).toEqual({
      model: 'garza-auto/auto',
      provider: {
        'garza-auto': {
          npm: '@ai-sdk/openai-compatible',
          name: 'Garza Auto',
          options: { baseURL: 'https://app.manifest.build/v1' },
          models: { auto: { name: 'auto', tool_call: true } },
        },
      },
    });
  });

  it('keeps model ids that contain slashes', async () => {
    const models = ['auto', 'anthropic/claude-sonnet-5-5-subscription'];
    await write({
      providers: { gw: { ...GATEWAY, models } },
      model: 'gw/anthropic/claude-sonnet-5-5-subscription',
    });
    const result = await openCodeProviders(file);
    expect(result.model).toBe('gw/anthropic/claude-sonnet-5-5-subscription');
  });

  it('drops a default model no provider lists', async () => {
    await write({ providers: { gw: GATEWAY }, model: 'gw/other' });
    expect((await openCodeProviders(file)).model).toBeUndefined();
  });

  it.each([
    ['a key in the file', { providers: { gw: { ...GATEWAY, apiKey: 'x' } } }],
    ['plain http', { providers: { gw: { ...GATEWAY, baseURL: 'http://example.com/v1' } } }],
    ['a bad id', { providers: { 'Bad Id': GATEWAY } }],
    ['no models', { providers: { gw: { ...GATEWAY, models: [] } } }],
  ])('ignores a file with %s', async (_, value) => {
    await write(value);
    expect(await openCodeProviders(file)).toEqual({});
  });

  it('ignores a file that is not JSON', async () => {
    await writeFile(file, 'not json');
    expect(await openCodeProviders(file)).toEqual({});
  });
});

describe('OpenCode MCP file', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'oc-mcp-'));
    file = path.join(dir, 'mcp.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const write = (value: unknown) => writeFile(file, JSON.stringify(value));
  const SERVER = { url: 'https://executor.sh/garza/mcp', headers: { Authorization: 'Bearer k' } };

  it('adds nothing when there is no file', async () => {
    expect(await openCodeMcpServers(file)).toEqual({});
  });

  it('turns each server into a remote one without OAuth', async () => {
    await write({ servers: { executor: SERVER } });
    expect(await openCodeMcpServers(file)).toEqual({
      mcp: { executor: { type: 'remote', ...SERVER, oauth: false } },
    });
  });

  it('masks every header value the way OpenCode reports it', async () => {
    await write({ servers: { executor: SERVER, open: { url: 'https://example.com/mcp' } } });
    const { mcp } = await openCodeMcpServers(file);
    expect(maskMcpHeaders(mcp)).toEqual({
      executor: {
        type: 'remote',
        url: SERVER.url,
        headers: { Authorization: '***' },
        oauth: false,
      },
      open: { type: 'remote', url: 'https://example.com/mcp', oauth: false },
    });
  });

  it.each([
    ['an id with an underscore', { servers: { my_server: SERVER } }],
    ['plain http', { servers: { executor: { ...SERVER, url: 'http://example.com/mcp' } } }],
    ['a local command', { servers: { executor: { ...SERVER, command: ['sh'] } } }],
    ['no servers key', { executor: SERVER }],
  ])('ignores a file with %s', async (_, value) => {
    await write(value);
    expect(await openCodeMcpServers(file)).toEqual({});
  });
});

describe('OpenCode prompt file', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'oc-prompt-'));
    file = path.join(dir, 'prompt.md');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("keeps OpenCode's own prompt when there is no file", async () => {
    expect(await openCodePrompt(file)).toBeUndefined();
  });

  it('uses the file, trimmed', async () => {
    await writeFile(file, '\n  Answer fully.\n\n');
    expect(await openCodePrompt(file)).toBe('Answer fully.');
  });

  it.each([
    ['empty', '  \n'],
    ['over the length limit', 'x'.repeat(32_001)],
  ])("keeps OpenCode's own prompt when the file is %s", async (_, text) => {
    await writeFile(file, text);
    expect(await openCodePrompt(file)).toBeUndefined();
  });
});
