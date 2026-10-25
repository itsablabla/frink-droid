import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FolderAccessError, listFolder, resolveInsideRoots } from './folders';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'frink-folders-')));
  root = join(base, 'workspace');
  outside = join(base, 'secret');
  await mkdir(join(root, 'project-b'), { recursive: true });
  await mkdir(join(root, 'project-a'));
  await mkdir(join(root, '.hidden'));
  await writeFile(join(root, 'notes.txt'), 'x');
  await mkdir(outside);
  await symlink(outside, join(root, 'escape'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('resolveInsideRoots', () => {
  it('allows the root and its sub-folders', async () => {
    expect(await resolveInsideRoots([root], root)).toBe(root);
    expect(await resolveInsideRoots([root], join(root, 'project-a'))).toBe(join(root, 'project-a'));
  });

  it('refuses paths outside the roots, including via .. and symlinks', async () => {
    await expect(resolveInsideRoots([root], outside)).rejects.toBeInstanceOf(FolderAccessError);
    await expect(resolveInsideRoots([root], join(root, '..', 'secret'))).rejects.toThrow(/outside/);
    await expect(resolveInsideRoots([root], join(root, 'escape'))).rejects.toThrow(/outside/);
    await expect(resolveInsideRoots([root], `${root}-sibling`)).rejects.toThrow();
  });

  it('refuses relative paths, files and missing folders', async () => {
    await expect(resolveInsideRoots([root], 'workspace')).rejects.toThrow(/absolute/);
    await expect(resolveInsideRoots([root], join(root, 'notes.txt'))).rejects.toThrow(/Not a/);
    await expect(resolveInsideRoots([root], join(root, 'nope'))).rejects.toThrow(/not found/);
  });
});

describe('listFolder', () => {
  it('lists visible directories only, sorted, with no parent at the root', async () => {
    const listing = await listFolder([root], undefined);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBeNull();
    // `escape` is a symlink, not a directory entry: it is not listed.
    expect(listing.entries.map((entry) => entry.name)).toEqual(['project-a', 'project-b']);
  });

  it('offers the parent inside a root', async () => {
    const listing = await listFolder([root], join(root, 'project-a'));
    expect(listing.parent).toBe(root);
  });

  it('creates a child folder and rejects unsafe names', async () => {
    const listing = await listFolder([root], root, 'new-project');
    expect(listing.entries.map((entry) => entry.name)).toContain('new-project');
    for (const bad of ['..', '.', 'a/b', '', 'x\0y']) {
      await expect(listFolder([root], root, bad)).rejects.toBeInstanceOf(FolderAccessError);
    }
  });
});
