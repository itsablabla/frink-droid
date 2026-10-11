import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSyntheticIdsForTests,
  translateDroidEvent,
  translateDroidLine,
} from './droid-events';

beforeEach(() => {
  _resetSyntheticIdsForTests();
});

describe('translateDroidEvent', () => {
  it('extracts the session id from a system init event with no chunks', () => {
    const t = translateDroidEvent({ type: 'system', subtype: 'init', session_id: 's-1' });
    expect(t).toEqual({ chunks: [], sessionId: 's-1' });
  });

  it('translates an assistant text block into a bracketed text stream', () => {
    const t = translateDroidEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    expect(t.chunks).toEqual([
      { type: 'text-start', id: 'droid-text-1' },
      { type: 'text-delta', id: 'droid-text-1', delta: 'hello' },
      { type: 'text-end', id: 'droid-text-1' },
    ]);
  });

  it('translates a reasoning block into a reasoning chunk', () => {
    const t = translateDroidEvent({
      type: 'assistant',
      message: { content: [{ type: 'reasoning', text: 'thinking…' }] },
    });
    expect(t.chunks).toEqual([{ type: 'reasoning', id: 'droid-reasoning-1', text: 'thinking…' }]);
  });

  it('translates a tool_use block into input-start + input-available', () => {
    const t = translateDroidEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    expect(t.chunks).toEqual([
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'Bash' },
      {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'Bash',
        input: { command: 'ls' },
      },
    ]);
  });

  it('translates tool_result blocks on user events, errors included', () => {
    const ok = translateDroidEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'out' }] },
    });
    expect(ok.chunks).toEqual([
      { type: 'tool-output-available', toolCallId: 'call-1', output: 'out' },
    ]);

    const err = translateDroidEvent({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'boom', is_error: true }],
      },
    });
    expect(err.chunks).toEqual([
      { type: 'tool-output-error', toolCallId: 'call-2', errorText: 'boom' },
    ]);
  });

  it('translates an error event into an error chunk', () => {
    expect(translateDroidEvent({ type: 'error', message: 'nope' }).chunks).toEqual([
      { type: 'error', errorText: 'nope' },
    ]);
  });

  it('marks the terminal result event complete and carries usage + session id', () => {
    const t = translateDroidEvent({
      type: 'result',
      subtype: 'success',
      session_id: 's-9',
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
    });
    expect(t.turnComplete).toBe(true);
    expect(t.sessionId).toBe('s-9');
    expect(t.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheCreationTokens: 0,
    });
    expect(t.chunks).toEqual([]);
  });

  it('surfaces a failed result as an error chunk', () => {
    const t = translateDroidEvent({ type: 'result', is_error: true, result: 'limit hit' });
    expect(t.chunks).toEqual([{ type: 'error', errorText: 'limit hit' }]);
    expect(t.turnComplete).toBe(true);
  });

  it('ignores unknown event kinds and malformed blocks', () => {
    expect(translateDroidEvent({ type: 'heartbeat' })).toEqual({ chunks: [] });
    expect(translateDroidEvent({ nonsense: true })).toEqual({ chunks: [] });
    expect(
      translateDroidEvent({ type: 'assistant', message: { content: [{ type: 'mystery' }] } })
        .chunks,
    ).toEqual([]);
  });
});

describe('translateDroidLine', () => {
  it('ignores blank lines and non-JSON noise', () => {
    expect(translateDroidLine('')).toEqual({ chunks: [] });
    expect(translateDroidLine('npm warn something')).toEqual({ chunks: [] });
  });

  it('parses a JSON line end to end', () => {
    const t = translateDroidLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    );
    expect(t.chunks).toHaveLength(3);
  });
});
