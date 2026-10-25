/**
 * Browser stand-in for the desktop artifact preview (a native WebContentsView over the window).
 * Here the artifact renders in a `sandbox="allow-scripts"` iframe (opaque origin: no cookies,
 * storage, or parent access) positioned over the same slot, with the same strict CSP document.
 */
import { artifactDocumentHtml } from '../../../shared/lib/artifacts/artifact-document';
import {
  isArtifactPreviewBoundsRequest,
  isArtifactPreviewCloseRequest,
  isArtifactPreviewOpenRequest,
} from '../../../shared/lib/artifacts/html-artifact';
import type {
  ArtifactPreviewBounds,
  ArtifactPreviewClosedEvent,
  ArtifactPreviewFocusReturnedEvent,
} from '../../../shared/types/artifacts/html-artifact';

type ArtifactPreviewApi = Window['desktopApi']['artifactPreview'];

function place(frame: HTMLIFrameElement, bounds: ArtifactPreviewBounds): void {
  Object.assign(frame.style, {
    left: `${bounds.x}px`,
    top: `${bounds.y}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  });
}

export function createWebArtifactPreview(doc: Document = document): ArtifactPreviewApi {
  const frames = new Map<string, HTMLIFrameElement>();
  const closedListeners = new Set<(event: ArtifactPreviewClosedEvent) => void>();
  const focusListeners = new Set<(event: ArtifactPreviewFocusReturnedEvent) => void>();

  const remove = (surfaceId: string) => {
    frames.get(surfaceId)?.remove();
    frames.delete(surfaceId);
  };

  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const active = doc.activeElement;
    for (const [surfaceId, frame] of frames) {
      if (frame === active) for (const listener of focusListeners) listener({ surfaceId });
    }
  });

  return {
    open: async (request) => {
      if (!isArtifactPreviewOpenRequest(request)) throw new TypeError('Invalid artifact preview');
      remove(request.surfaceId);
      const frame = doc.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', request.artifact.title);
      frame.dataset.frinkArtifactSurface = request.surfaceId;
      Object.assign(frame.style, {
        position: 'fixed',
        border: '0',
        zIndex: '40',
        background: 'white',
        colorScheme: 'normal',
      });
      frame.srcdoc = artifactDocumentHtml(request);
      place(frame, request.bounds);
      doc.body.appendChild(frame);
      frames.set(request.surfaceId, frame);
    },
    focus: async (request) => {
      if (!isArtifactPreviewCloseRequest(request)) throw new TypeError('Invalid preview focus');
      frames.get(request.surfaceId)?.focus();
    },
    updateBounds: async (request) => {
      if (!isArtifactPreviewBoundsRequest(request)) throw new TypeError('Invalid preview bounds');
      const frame = frames.get(request.surfaceId);
      if (frame) place(frame, request.bounds);
    },
    close: async (request) => {
      if (!isArtifactPreviewCloseRequest(request)) throw new TypeError('Invalid preview close');
      remove(request.surfaceId);
    },
    isHostFocused: async () => doc.hasFocus(),
    onClosed: (callback) => {
      closedListeners.add(callback);
      return () => closedListeners.delete(callback);
    },
    onFocusReturned: (callback) => {
      focusListeners.add(callback);
      return () => focusListeners.delete(callback);
    },
  };
}
