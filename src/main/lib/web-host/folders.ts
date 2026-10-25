/**
 * Server-side folder browsing for the browser folder picker. Only directories under the
 * configured roots are listed or created; symlinks are resolved first so a link cannot escape.
 */
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WebHostDirectoryListing } from '../../../shared/lib/web-host';

export class FolderAccessError extends Error {}

const MAX_ENTRIES = 2_000;
const VALID_CHILD_NAME = /^[^/\\\0]{1,255}$/;

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** The real path of `candidate` when it is an existing directory inside one of `roots`. */
export async function resolveInsideRoots(roots: string[], candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new FolderAccessError('Path must be absolute');
  let real: string;
  try {
    real = await realpath(resolve(candidate));
  } catch {
    throw new FolderAccessError('Folder not found');
  }
  const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
  if (!realRoots.some((root) => isInside(root, real))) {
    throw new FolderAccessError('Folder is outside the allowed locations');
  }
  const info = await stat(real);
  if (!info.isDirectory()) throw new FolderAccessError('Not a folder');
  return real;
}

/** List the sub-folders of `path` (default: the first root), optionally creating one first. */
export async function listFolder(
  roots: string[],
  path: string | undefined,
  createChild?: string,
): Promise<WebHostDirectoryListing> {
  const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
  const dir = await resolveInsideRoots(roots, path ?? realRoots[0] ?? '/');
  if (createChild !== undefined) {
    const name = createChild.trim();
    if (!VALID_CHILD_NAME.test(name) || name === '.' || name === '..') {
      throw new FolderAccessError('Invalid folder name');
    }
    await mkdir(join(dir, name));
  }
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries = dirents
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES);
  const atRoot = realRoots.includes(dir);
  return {
    path: dir,
    parent: atRoot ? null : dirname(dir),
    roots: realRoots,
    entries,
  };
}
