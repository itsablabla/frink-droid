import { describe, expect, it, vi } from 'vitest';
import { isValidTabId, TabRegistry, VIRTUAL_WEB_CONTENTS_ID_BASE } from './clients';

function socket() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 };
}

function sentMessages(fake: ReturnType<typeof socket>) {
  return fake.send.mock.calls.map(([frame]) => JSON.parse(frame as string));
}

describe('isValidTabId', () => {
  it('accepts sessionStorage ids and refuses junk', () => {
    expect(isValidTabId('abcDEF12-_')).toBe(true);
    expect(isValidTabId('short')).toBe(false);
    expect(isValidTabId('has space123')).toBe(false);
    expect(isValidTabId(42)).toBe(false);
  });
});

describe('TabRegistry', () => {
  it('gives each tab a stable virtual id above real webContents ids', () => {
    const registry = new TabRegistry();
    const a = registry.ensure('tab-aaaaaaaa', 's1');
    const b = registry.ensure('tab-bbbbbbbb', 's1');
    expect(a.virtualId).toBeGreaterThan(VIRTUAL_WEB_CONTENTS_ID_BASE);
    expect(b.virtualId).not.toBe(a.virtualId);
    expect(registry.ensure('tab-aaaaaaaa', 's2')).toBe(a);
    expect(registry.byVirtual(a.virtualId)).toBe(a);
  });

  it('broadcasts pushes to connected tabs and leader-only pushes to the active one', () => {
    let now = 0;
    const registry = new TabRegistry(() => now);
    const a = registry.ensure('tab-aaaaaaaa', 's');
    const b = registry.ensure('tab-bbbbbbbb', 's');
    a.bridge = socket();
    b.bridge = socket();
    expect(registry.broadcast('x', [1])).toBe(2);
    now = 10;
    registry.markActive(b);
    registry.pushToLeader('task:chat-ready', [{}]);
    expect(sentMessages(b.bridge as ReturnType<typeof socket>).map((m) => m.ch)).toEqual([
      'x',
      'task:chat-ready',
    ]);
    expect(sentMessages(a.bridge as ReturnType<typeof socket>).map((m) => m.ch)).toEqual(['x']);
  });

  it('only accepts a reply from the tab that was asked', async () => {
    const registry = new TabRegistry();
    const asked = registry.ensure('tab-aaaaaaaa', 's');
    const other = registry.ensure('tab-bbbbbbbb', 's');
    asked.bridge = socket();
    other.bridge = socket();
    const answer = registry.request({ kind: 'pick-folder', title: 'Pick' }, asked);
    const [request] = sentMessages(asked.bridge as ReturnType<typeof socket>);
    expect(request).toMatchObject({ t: 'request', request: { kind: 'pick-folder' } });
    registry.reply(other, request.id, '/evil');
    registry.reply(asked, request.id, '/workspace/a');
    await expect(answer).resolves.toBe('/workspace/a');
  });

  it('resolves null when no tab is connected or the tab goes away', async () => {
    const registry = new TabRegistry();
    await expect(registry.request({ kind: 'open-external', url: 'https://x' })).resolves.toBeNull();
    const tab = registry.ensure('tab-aaaaaaaa', 's');
    tab.bridge = socket();
    const pending = registry.request({ kind: 'open-external', url: 'https://x' });
    tab.bridge = null;
    expect(registry.forgetIfIdle(tab)).toBe(true);
    await expect(pending).resolves.toBeNull();
  });

  it('keeps a tab that still has a tRPC socket', () => {
    const registry = new TabRegistry();
    const tab = registry.ensure('tab-aaaaaaaa', 's');
    tab.trpcSockets = 1;
    expect(registry.forgetIfIdle(tab)).toBe(false);
  });

  it('closes the bridges of a signed-out session only', () => {
    const registry = new TabRegistry();
    const mine = registry.ensure('tab-aaaaaaaa', 'mine');
    const theirs = registry.ensure('tab-bbbbbbbb', 'theirs');
    mine.bridge = socket();
    theirs.bridge = socket();
    registry.closeSession('mine');
    expect(mine.bridge.close).toHaveBeenCalledWith(4401, 'signed out');
    expect(theirs.bridge.close).not.toHaveBeenCalled();
  });
});
