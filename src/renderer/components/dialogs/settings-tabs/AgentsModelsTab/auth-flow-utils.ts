export type AccountType = 'claude-code' | 'codex' | 'droid';

export type AccountAuthSelection = {
  id: string;
  label: string;
  isApiKey?: boolean;
  type?: AccountType;
  source?: string | null;
};

export function shouldUseInlineCredentialEdit(account: {
  isApiKey?: boolean;
  type?: AccountType;
}): boolean {
  return Boolean(account.isApiKey);
}

/**
 * Which connect page a passthrough row routes to. A codex row (type `'codex'` or
 * source `'codex-passthrough'`) opens the Codex connect page; a droid row the Droid
 * connect page; everything else defaults to Claude. Returns `undefined` for the
 * non-codex/droid case so the field is omitted (the App.tsx gate treats absent as Claude).
 */
export function providerForAccount(account: {
  type?: AccountType;
  source?: string | null;
}): 'codex' | 'droid' | undefined {
  if (account.type === 'codex' || account.source === 'codex-passthrough') return 'codex';
  if (account.type === 'droid' || account.source === 'droid-passthrough') return 'droid';
  return undefined;
}

export function buildPendingReauthState(account: {
  id: string;
  label: string;
  type?: AccountType;
  source?: string | null;
}) {
  return {
    accountId: account.id,
    accountLabel: account.label,
    mode: 'reauth' as const,
    returnToSettings: true,
    provider: providerForAccount(account),
  };
}

/** No label: the connect page names the account after the login it detects. */
export function buildPendingAddState(provider?: 'codex' | 'droid') {
  return {
    accountLabel: '',
    mode: 'add' as const,
    returnToSettings: true,
    provider,
  };
}

/** "Claude API key", then "Claude API key 2"…: account names must be unique. */
export function nextApiKeyName(labels: string[]): string {
  let name = 'Claude API key';
  for (let n = 2; labels.includes(name); n++) name = `Claude API key ${n}`;
  return name;
}
