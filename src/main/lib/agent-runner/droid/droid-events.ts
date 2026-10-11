/**
 * Pure mapping functions between droid's `--output-format stream-json` wire shape
 * and Frink's {@link UIMessageChunk} stream.
 *
 * Kept as TOP-LEVEL pure functions (no process, no I/O) so they unit-test without
 * spawning anything, mirroring `codex/codex-events.ts`.
 *
 * Wire contract: `droid exec --output-format stream-json` emits one JSON object
 * per line, Claude-Code-style — `system/init` (carries `session_id`), `assistant`
 * messages whose `content` blocks are `text` / `reasoning` / `tool_use`,
 * `tool_result` blocks inside `user` messages, an `error` event, and a terminal
 * `result` event carrying usage totals. Unknown event types translate to NOTHING
 * (empty chunk list) rather than an error, so a CLI upgrade that adds event kinds
 * degrades gracefully instead of killing the turn.
 */

import { z } from 'zod';
import type { UIMessageChunk } from '../../claude/types';

// ── Wire schemas (tolerant: extra fields pass through, missing ones degrade) ──

const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
});

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const reasoningBlockSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
});

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

const contentBlockSchema = z.union([
  toolUseBlockSchema,
  textBlockSchema,
  reasoningBlockSchema,
  toolResultBlockSchema,
]);

const systemEventSchema = z.object({
  type: z.literal('system'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
});

const assistantEventSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({ content: z.array(z.unknown()) }),
  session_id: z.string().optional(),
});

const userEventSchema = z.object({
  type: z.literal('user'),
  message: z.object({ content: z.array(z.unknown()) }),
});

const errorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string().optional(),
  error: z.string().optional(),
});

const usageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});

const resultEventSchema = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().optional(),
  usage: usageSchema.optional(),
});

const droidEventSchema = z.union([
  systemEventSchema,
  assistantEventSchema,
  userEventSchema,
  errorEventSchema,
  resultEventSchema,
]);

export type DroidUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/** What one translated line yields: chunks to stream + session/usage side-channel data. */
export type DroidTranslation = {
  chunks: UIMessageChunk[];
  /** Droid session id, when this event carries one (used for `-s` resume next turn). */
  sessionId?: string;
  /** Token totals, present only on the terminal `result` event. */
  usage?: DroidUsage;
  /** True exactly for the terminal `result` event. */
  turnComplete?: boolean;
};

const EMPTY: DroidTranslation = { chunks: [] };

let syntheticIdCounter = 0;
/** Monotonic ids for text/reasoning chunks within a process (droid blocks carry none). */
function nextSyntheticId(prefix: string): string {
  syntheticIdCounter += 1;
  return `droid-${prefix}-${syntheticIdCounter}`;
}

/** Test-only: make synthetic ids deterministic again. */
export function _resetSyntheticIdsForTests(): void {
  syntheticIdCounter = 0;
}

function translateContentBlock(block: unknown): UIMessageChunk[] {
  const parsed = contentBlockSchema.safeParse(block);
  if (!parsed.success) return [];
  const b = parsed.data;
  switch (b.type) {
    case 'text': {
      if (!b.text) return [];
      const id = nextSyntheticId('text');
      return [
        { type: 'text-start', id },
        { type: 'text-delta', id, delta: b.text },
        { type: 'text-end', id },
      ];
    }
    case 'reasoning': {
      if (!b.text) return [];
      return [{ type: 'reasoning', id: nextSyntheticId('reasoning'), text: b.text }];
    }
    case 'tool_use':
      return [
        { type: 'tool-input-start', toolCallId: b.id, toolName: b.name },
        {
          type: 'tool-input-available',
          toolCallId: b.id,
          toolName: b.name,
          input: b.input ?? {},
        },
      ];
    case 'tool_result':
      return b.is_error
        ? [
            {
              type: 'tool-output-error',
              toolCallId: b.tool_use_id,
              errorText:
                typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
            },
          ]
        : [{ type: 'tool-output-available', toolCallId: b.tool_use_id, output: b.content ?? '' }];
  }
}

function toUsage(u: z.infer<typeof usageSchema> | undefined): DroidUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Translate one parsed stream-json event into Frink chunks. Unknown/malformed
 * events yield {@link EMPTY} by design (see module docblock).
 */
export function translateDroidEvent(event: unknown): DroidTranslation {
  const parsed = droidEventSchema.safeParse(event);
  if (!parsed.success) return EMPTY;
  const e = parsed.data;
  switch (e.type) {
    case 'system':
      return e.session_id ? { chunks: [], sessionId: e.session_id } : EMPTY;
    case 'assistant':
      return {
        chunks: e.message.content.flatMap(translateContentBlock),
        ...(e.session_id ? { sessionId: e.session_id } : {}),
      };
    case 'user':
      // Only tool_result blocks matter from user-role events (tool output echoes).
      return { chunks: e.message.content.flatMap(translateContentBlock) };
    case 'error':
      return {
        chunks: [{ type: 'error', errorText: e.message ?? e.error ?? 'Droid reported an error.' }],
      };
    case 'result':
      return {
        chunks: e.is_error ? [{ type: 'error', errorText: e.result ?? 'Droid turn failed.' }] : [],
        ...(e.session_id ? { sessionId: e.session_id } : {}),
        usage: toUsage(e.usage),
        turnComplete: true,
      };
  }
}

/**
 * Parse one raw stdout line. Blank lines and non-JSON noise (npm warnings, etc.)
 * translate to nothing — stream-json interleaves with nothing on a healthy run,
 * so anything unparseable is logged by the caller, never fatal.
 */
export function translateDroidLine(line: string): DroidTranslation {
  const trimmed = line.trim();
  if (!trimmed) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return EMPTY;
  }
  return translateDroidEvent(parsed);
}
