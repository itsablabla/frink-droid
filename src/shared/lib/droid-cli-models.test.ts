import { describe, expect, it } from 'vitest';
import { DROID_CLI_MODELS, DROID_DEFAULT_MODEL_ID, resolveDroidCliModel } from './droid-cli-models';

describe('droid model catalog', () => {
  it('namespaces every picker id with droid- and keeps ids unique', () => {
    const ids = DROID_CLI_MODELS.map((m) => m.id);
    expect(ids.every((id) => id.startsWith('droid-'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defines a default model id that exists in the catalog', () => {
    expect(DROID_CLI_MODELS.some((m) => m.id === DROID_DEFAULT_MODEL_ID)).toBe(true);
  });
});

describe('resolveDroidCliModel', () => {
  it('resolves a known picker id to its CLI slug', () => {
    expect(resolveDroidCliModel('droid-gpt-5')).toEqual({ model: 'gpt-5' });
  });

  it('falls back to the default for unknown or missing ids', () => {
    const fallback = resolveDroidCliModel(DROID_DEFAULT_MODEL_ID);
    expect(resolveDroidCliModel('droid-nonexistent')).toEqual(fallback);
    expect(resolveDroidCliModel(undefined)).toEqual(fallback);
  });

  it('never returns a picker id as the CLI value', () => {
    for (const m of DROID_CLI_MODELS) {
      expect(resolveDroidCliModel(m.id).model).toBe(m.cliValue);
      expect(resolveDroidCliModel(m.id).model.startsWith('droid-')).toBe(false);
    }
  });
});
