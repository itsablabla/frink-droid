/**
 * Web mode stand-ins for desktop-only UI: the folder picker dialog and "open this link" prompt
 * (when the browser blocks a popup without a click). Renders nothing inside the Electron app.
 */
import { Button, Input } from '@benord-labs/frink-primitives';
import { ChevronLeft, Folder, FolderPlus } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import type { WebHostDirectoryListing, WebHostServerRequest } from '../../../shared/lib/web-host';
import { getWebBridge, isWebHost } from '../../lib/web-host/install';
import { type PendingWebRequest, webHostRequests } from '../../lib/web-host/requests';
import { WebSessionBar } from '../WebSessionBar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

type FolderRequest = Extract<WebHostServerRequest, { kind: 'pick-folder' }>;

function FolderPicker({
  request,
  onDone,
}: {
  request: FolderRequest;
  onDone: (path: string | null) => void;
}): ReactElement {
  const [listing, setListing] = useState<WebHostDirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const load = useCallback(async (path?: string, createChild?: string) => {
    const bridge = getWebBridge();
    if (!bridge) return;
    try {
      setListing((await bridge.listFolder(path, createChild)) as WebHostDirectoryListing);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open that folder');
    }
  }, []);

  useEffect(() => {
    void load(request.defaultPath);
  }, [load, request.defaultPath]);

  return (
    <Dialog open onOpenChange={(open) => !open && onDone(null)}>
      <DialogContent className="w-[560px]">
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {listing?.path ?? 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void load(listing.parent)}
          >
            <ChevronLeft className="h-4 w-4" />
            Up
          </Button>
          {listing && listing.roots.length > 1 && (
            <select
              aria-label="Location"
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={listing.roots.find((root) => listing.path.startsWith(root)) ?? ''}
              onChange={(event) => void load(event.target.value)}
            >
              {listing.roots.map((root) => (
                <option key={root} value={root}>
                  {root}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="h-72 overflow-y-auto rounded-md border" role="listbox" aria-label="Folders">
          {listing?.entries.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">No folders here.</p>
          )}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-selected={false}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              onDoubleClick={() => void load(entry.path)}
              onClick={() => void load(entry.path)}
            >
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{entry.name}</span>
            </button>
          ))}
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newName.trim() || !listing) return;
            void load(listing.path, newName.trim()).then(() => setNewName(''));
          }}
        >
          <Input
            aria-label="New folder name"
            placeholder="New folder name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!newName.trim()}>
            <FolderPlus className="h-4 w-4" />
            Create
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button disabled={!listing} onClick={() => listing && onDone(listing.path)}>
            Open this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkPrompt({ url, onDone }: { url: string; onDone: () => void }): ReactElement {
  const [callback, setCallback] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const relay = async () => {
    const bridge = getWebBridge();
    if (!bridge) return;
    const result = (await bridge.relayOAuthCallback(callback.trim())) as
      | { ok: true; status: number }
      | { ok: false; error: string };
    if (result.ok) onDone();
    else setStatus(result.error);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onDone()}>
      <DialogContent className="w-[520px]">
        <DialogHeader>
          <DialogTitle>Open link</DialogTitle>
          <DialogDescription className="break-all">{url}</DialogDescription>
        </DialogHeader>
        <Button asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open in a new tab
          </a>
        </Button>
        <div className="grid gap-2 text-sm">
          <p className="text-muted-foreground">
            Signing in? If the provider sends you to a localhost page that does not load, copy that
            page&apos;s full address and paste it here.
          </p>
          <div className="flex gap-2">
            <Input
              aria-label="Callback address"
              placeholder="http://localhost:…/callback?code=…"
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
            />
            <Button variant="secondary" disabled={!callback.trim()} onClick={() => void relay()}>
              Finish
            </Button>
          </div>
          {status && (
            <p role="alert" className="text-destructive">
              {status}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onDone}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WebHostDialogsInner(): ReactElement {
  const [requests, setRequests] = useState<PendingWebRequest[]>([]);
  useEffect(() => webHostRequests.subscribe(setRequests), []);
  const current = requests[0];
  let dialog: ReactElement | null = null;
  if (current?.request.kind === 'pick-folder') {
    dialog = (
      <FolderPicker
        key={current.key}
        request={current.request}
        onDone={(path) => current.resolve(path)}
      />
    );
  } else if (current?.request.kind === 'open-external') {
    dialog = (
      <LinkPrompt
        key={current.key}
        url={current.request.url}
        onDone={() => current.resolve(true)}
      />
    );
  }
  return (
    <>
      <WebSessionBar />
      {dialog}
    </>
  );
}

export function WebHostDialogs(): ReactElement | null {
  return isWebHost() ? <WebHostDialogsInner /> : null;
}
