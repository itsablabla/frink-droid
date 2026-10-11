/**
 * Factory Droid CLI models for `droid exec`: the picker id encodes the Droid model slug.
 * Droid is multi-model (Anthropic + OpenAI under Factory's own slugs) and selects via
 * `droid exec -m <slug>`; reasoning depth is baked into the slug (no separate effort field,
 * unlike Codex). Slug provenance: https://docs.factory.com/droid-cli/cli-reference.
 */

export type DroidCliModel = {
  id: string;
  familyId: string;
  familyName: string;
  variantLabel: string;
  contextWindow: string;
  /** Model slug sent to `droid exec -m`. */
  cliValue: string;
};

/**
 * Single source of truth for the droid model slugs + their picker family metadata.
 * `isDefault` seeds chats with no valid droid selection; persisted droid ids pass
 * through untouched (the executor resolves right before spawn).
 */
export const DROID_MODEL_SLUGS: {
  slug: string;
  familyId: string;
  familyName: string;
  isDefault?: boolean;
}[] = [
  { slug: 'claude-sonnet-4-5', familyId: 'droid-sonnet-4-5', familyName: 'Claude Sonnet 4.5', isDefault: true },
  { slug: 'claude-opus-4-1', familyId: 'droid-opus-4-1', familyName: 'Claude Opus 4.1' },
  { slug: 'gpt-5', familyId: 'droid-gpt-5', familyName: 'GPT-5' },
  { slug: 'gpt-5-codex', familyId: 'droid-gpt-5-codex', familyName: 'GPT-5-Codex' },
];

const DROID_CONTEXT_WINDOW = 'Large context (varies by model)';

/** Full list for the model picker; `cliValue` is the slug forwarded to `droid exec -m`. */
export const DROID_CLI_MODELS: DroidCliModel[] = DROID_MODEL_SLUGS.map((m) => ({
  id: `droid-${m.slug}`,
  familyId: m.familyId,
  familyName: m.familyName,
  variantLabel: '',
  contextWindow: DROID_CONTEXT_WINDOW,
  cliValue: m.slug,
}));

/** Picker id new chats seed to: the default droid model. */
export const DROID_DEFAULT_MODEL_ID: string = (() => {
  const def = DROID_MODEL_SLUGS.find((m) => m.isDefault) ?? DROID_MODEL_SLUGS[0];
  return `droid-${def.slug}`;
})();

const DROID_MODEL_BY_ID = new Map(DROID_CLI_MODELS.map((m) => [m.id, m]));

/**
 * Resolve a droid picker id (e.g. `droid-claude-sonnet-4-5`) to the slug `droid exec -m`
 * wants. The executor is the single conversion boundary — the picker id is stored and
 * forwarded raw, then resolved here right before the droid runner spawns. An unknown or
 * missing id falls back to {@link DROID_DEFAULT_MODEL_ID} so droid never crashes on a
 * stale value.
 */
export function resolveDroidCliModel(pickerId: string | undefined): { model: string } {
  const m =
    (pickerId && DROID_MODEL_BY_ID.get(pickerId)) || DROID_MODEL_BY_ID.get(DROID_DEFAULT_MODEL_ID);
  // DROID_DEFAULT_MODEL_ID is always a real catalog id, so m is defined; assert for the type.
  if (!m) throw new Error('Droid default model id is not in the catalog');
  return { model: m.cliValue };
}

// DROID_MODEL_FAMILIES + DROID_MODEL_ID_MAP are derived ONCE in ./models (their single
// home) — not re-derived here, to avoid drift.
