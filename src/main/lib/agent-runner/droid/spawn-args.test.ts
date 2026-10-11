import { describe, expect, it } from 'vitest';
import { buildDroidSpawnArgs, mapModeToDroidAutonomy } from './spawn-args';

describe('mapModeToDroidAutonomy', () => {
  it('maps plan mode to read-only regardless of the Auto switch', () => {
    expect(mapModeToDroidAutonomy('plan', true)).toBe('read-only');
    expect(mapModeToDroidAutonomy('plan', false)).toBe('read-only');
  });

  it('maps agent mode to low without Auto, medium with Auto', () => {
    expect(mapModeToDroidAutonomy('agent', false)).toBe('low');
    expect(mapModeToDroidAutonomy('agent', true)).toBe('medium');
  });

  it('maps debug mode like agent mode', () => {
    expect(mapModeToDroidAutonomy('debug', false)).toBe('low');
    expect(mapModeToDroidAutonomy('debug', true)).toBe('medium');
  });
});

describe('buildDroidSpawnArgs', () => {
  it('builds a first-turn exec invocation with stream-json on both ends', () => {
    expect(buildDroidSpawnArgs({ model: 'claude-sonnet-4-5', autonomy: 'low' })).toEqual([
      'exec',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '-m',
      'claude-sonnet-4-5',
      '--auto',
      'low',
    ]);
  });

  it('appends -s for a resumed session', () => {
    const args = buildDroidSpawnArgs({
      model: 'gpt-5',
      autonomy: 'read-only',
      sessionId: 'session-123',
    });
    expect(args.slice(-2)).toEqual(['-s', 'session-123']);
    expect(args).toContain('read-only');
  });

  it('never embeds the prompt in argv (stdin carries it)', () => {
    const args = buildDroidSpawnArgs({ model: 'gpt-5', autonomy: 'high' });
    // Every element is a known flag or value — no free-text positional prompt.
    expect(args[0]).toBe('exec');
    expect(args.length % 2).toBe(1); // 'exec' + flag/value pairs only
  });
});
