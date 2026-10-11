/**
 * Argument builders for `droid exec` (headless stream-json mode).
 *
 * Droid runs HEADLESS with a preset autonomy tier — unlike Claude/Codex there is
 * no interactive per-tool approval protocol, so Frink maps its chat mode onto the
 * CLI's `--auto` ladder conservatively (plan → read-only; agent/debug → low).
 * CLI contract: https://docs.factory.com/droid-cli/cli-reference.
 */

import type { ChatMode } from '../../../../shared/types/chat-mode';

/** Droid's autonomy ladder, most to least conservative. */
export type DroidAutonomyLevel = 'read-only' | 'low' | 'medium' | 'high';

/**
 * Frink chat mode → droid `--auto` tier. Deliberately conservative: plan mode must
 * not write, and agent mode starts at `low` (file edits in the workspace, no
 * riskier actions) until interactive approvals can be bridged. `autoMode` (the
 * composer's Auto switch) raises agent mode to `medium` — the user opted into
 * fewer stops.
 */
export function mapModeToDroidAutonomy(mode: ChatMode, autoMode: boolean): DroidAutonomyLevel {
  if (mode === 'plan') return 'read-only';
  return autoMode ? 'medium' : 'low';
}

export type DroidSpawnParams = {
  /** Droid model slug (already resolved via `resolveDroidCliModel`). */
  model: string;
  autonomy: DroidAutonomyLevel;
  /** Resume an existing droid session; omitted on the first turn. */
  sessionId?: string;
};

/**
 * Build the argv (after the binary path) for one `droid exec` turn. The prompt is
 * NOT included: the runner writes it over stdin (`--input-format stream-json`) so
 * multi-megabyte briefings never hit ARG_MAX and never leak into `ps` output.
 */
export function buildDroidSpawnArgs(params: DroidSpawnParams): string[] {
  return [
    'exec',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '-m',
    params.model,
    '--auto',
    params.autonomy,
    ...(params.sessionId ? ['-s', params.sessionId] : []),
  ];
}
