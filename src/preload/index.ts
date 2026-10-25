/* eslint-disable max-lines, max-lines-per-function */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { exposeElectronTRPC } from 'trpc-electron/main';
import type { ShellOpenExternalResult } from '../shared/shell-external-url';
import type { TranscriptTerminalDurability } from '../shared/types/assistant-message';
import type { ChatMode } from '../shared/types/chat-mode';
import type { SocketPermissionProjection } from '../shared/types/permissions';
import type { TaskChatReadyData } from '../shared/types/task-chat-ready';
import { type ArtifactPreviewApi, artifactPreviewApi } from './artifact-preview';
import {
  createDesktopApi,
  type DesktopBroadcastChannel,
  type MoveChatRequest,
  type SocketExecuteCompleteData,
  type UpdateInfo,
} from '../shared/lib/desktop-api';

// Only initialize Sentry in production to avoid IPC errors in dev mode.
// Preload runs in an isolated context but uses the renderer SDK; events
// flow back to the main process via IPC.
if (process.env.NODE_ENV === 'production' && process.env.MAIN_VITE_SENTRY_DSN) {
  void Promise.all([import('@sentry/electron/renderer'), import('../shared/sentry/scrubber')]).then(
    ([Sentry, { beforeBreadcrumb, beforeSend }]) => {
      Sentry.init({
        dsn: process.env.MAIN_VITE_SENTRY_DSN,
        defaultIntegrations: false,
        beforeSend: (event) => beforeSend(event),
        beforeBreadcrumb: (breadcrumb) => beforeBreadcrumb(breadcrumb),
      });
    },
  );
}

// Isolated QA boots wipe the profile; pre-seeding the welcome flag lands the driver on
// the feature shell. The literal must match STORAGE_KEY in renderer WelcomeSplash (no cross-process import).
if (process.env.FRINK_QA_SKIP_WELCOME) {
  window.localStorage.setItem('frink:has-seen-welcome', 'true');
}
if (process.env.FRINK_CDP_PORT) contextBridge.exposeInMainWorld('__FRINK_QA__', true);

exposeElectronTRPC();

// Expose Electron webUtils for drag-and-drop file path resolution (used by file tree and terminal)
contextBridge.exposeInMainWorld('webUtils', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});

contextBridge.exposeInMainWorld(
  'desktopApi',
  createDesktopApi(ipcRenderer, {
    platform: process.platform,
    arch: process.arch,
    artifactPreview: artifactPreviewApi,
  }),
);

// Type definitions
export type { UpdateInfo };

export type UpdateProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type DesktopApi = {
  platform: NodeJS.Platform;
  arch: string;
  getVersion: () => Promise<string>;
  isPackaged: () => Promise<boolean>;
  // Auto-update
  checkForUpdates: () => Promise<UpdateInfo | null>;
  downloadUpdate: () => Promise<boolean>;
  installUpdate: () => void;
  onUpdateChecking: (callback: () => void) => () => void;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateNotAvailable: (callback: () => void) => () => void;
  onProviderUnbridged: (
    callback: (data: {
      projectId: string;
      providerKind: 'claude-code' | 'cursor';
      skills: { name: string; sourcePath: string }[];
    }) => void,
  ) => () => void;
  onUpdateProgress: (callback: (progress: UpdateProgress) => void) => () => void;
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateError: (callback: (error: string) => void) => () => void;
  onUpdateManualCheck: (callback: () => void) => () => void;
  onFileOperationProgress: (
    callback: (progress: {
      operationId: string;
      current: number;
      total: number;
      currentFile: string;
      done: boolean;
    }) => void,
  ) => () => void;
  // Window controls
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
  windowToggleFullscreen: () => Promise<void>;
  windowIsFullscreen: () => Promise<boolean>;
  artifactPreview: ArtifactPreviewApi;
  setWindowFramePreference: (useNativeFrame: boolean) => Promise<boolean>;
  getWindowFrameState: () => Promise<boolean>;
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void;
  onFocusChange: (callback: (isFocused: boolean) => void) => () => void;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  zoomReset: () => Promise<void>;
  getZoom: () => Promise<number>;
  toggleDevTools: () => Promise<void>;
  unlockDevTools: () => Promise<void>;
  setAnalyticsOptOut: (optedOut: boolean) => Promise<void>;
  setBadge: (count: number | null) => Promise<void>;
  setBadgeIcon: (imageData: string | null) => Promise<void>;
  showNotification: (options: { title: string; body: string }) => Promise<void>;
  openExternal: (url: string) => Promise<ShellOpenExternalResult>;
  clipboardWrite: (text: string) => Promise<void>;
  clipboardRead: () => Promise<string>;
  // MCP auto-import
  onMcpImported: (
    callback: (result: { imported: number; conflicts: number }) => void,
  ) => () => void;
  // MCP OAuth
  onMcpAuthCompleted: (
    callback: (data: {
      serverName: string;
      projectPath?: string;
      success: boolean;
      error?: string;
    }) => void,
  ) => () => void;
  // Shortcuts
  onShortcutNewAgent: (callback: () => void) => () => void;
  // Socket connection status events
  on: (channel: DesktopBroadcastChannel, callback: (data?: unknown) => void) => () => void;
  // File changes
  onFileChanged: (
    callback: (data: { filePath: string; type: string; subChatId: string }) => void,
  ) => () => void;
  // Git status changes (from file watcher)
  onGitStatusChanged: (
    callback: (data: {
      worktreePath: string;
      changes: Array<{ path: string; type: 'add' | 'change' | 'unlink' }>;
    }) => void,
  ) => () => void;
  // IDE config change detection (agents, skills, hooks, etc.)
  onIdeConfigChanged?: (
    callback: (data: {
      worktreePath: string;
      changes: Array<{ resourceType: string; origin: string; type?: string }>;
    }) => void,
  ) => () => void;
  subscribeToGitWatcher: (worktreePath: string) => Promise<void>;
  unsubscribeFromGitWatcher: (worktreePath: string) => Promise<void>;
  // Task execution events
  onTaskChatReady: (callback: (data: TaskChatReadyData) => void) => () => void;
  onAgentRequestMoveChat: (callback: (data: MoveChatRequest) => void) => () => void;
  sendAgentMoveChatResponse: (requestId: string, approved: boolean) => void;
  onAgentMoveChatApproved: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      projectId: string;
      projectName: string;
      projectPath: string;
      requestedWorktreePath: string | null;
      navigationSessionId: string;
    }) => void,
  ) => () => void;
  // Permission prompt events
  onPermissionRequest: (
    callback: (data: {
      requestId: string;
      scope:
        | { type: 'git_remote'; gitRemote: string }
        | { type: 'folder'; folderId: string }
        | { type: 'bash' };
      path: string;
      operation: 'read' | 'write' | 'delete' | 'bash';
      reason?: string;
      taskId?: string;
      projectPath?: string;
    }) => void,
  ) => () => void;
  sendPermissionResponse: (response: {
    requestId: string;
    approved: boolean;
    scope?: 'project' | 'user';
    ruleString?: string;
    ruleType?: 'allow' | 'deny' | 'ask';
  }) => void;
  onPermissionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
  // Socket-based permission events
  onSocketPermissionRequest: (callback: (data: SocketPermissionProjection) => void) => () => void;
  sendSocketPermissionResponse: (response: {
    chatId: string;
    subChatId: string;
    requestId: string;
    approved: boolean;
    /** Set when the response is a system-driven cancellation (pane close, timeout) — persistence paths must skip. */
    timedOut?: boolean;
    scope?: 'project' | 'user';
    ruleString?: string;
    ruleType?: 'allow' | 'deny' | 'ask';
    /** "Always allow this flow" — writes flows.agent_invocable, not a rule. */
    flowGrant?: boolean;
  }) => void;
  onSocketPermissionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
  // Socket events
  onSocketError: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      error: string;
      assistantMessageId?: string;
      /** UUID we attempted to resume; present when the failure was a stale Claude session. */
      failedSessionId?: string;
      /** Error classification (e.g. 'RATE_LIMIT_SDK') — drives renderer toast + failure handling. */
      category?: string;
      streamEpoch?: string;
      terminalDurability?: TranscriptTerminalDurability;
    }) => void,
  ) => () => void;
  onSocketStreamChunk: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      assistantMessageId: string;
      chunk: unknown;
      parts?: unknown[];
      messageIndex: number;
      streamEpoch?: string;
    }) => void,
  ) => () => void;
  onSocketExecuteStart: (
    callback: (data: { chatId: string; subChatId: string; assistantMessageId: string }) => void,
  ) => () => void;
  onSocketExecuteComplete: (callback: (data: SocketExecuteCompleteData) => void) => () => void;
  onSocketTaskSignalPersisted: (
    callback: (data: { taskId: string; status: string; isFlowLinked: boolean }) => void,
  ) => () => void;
  onSocketMessageSaved: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      message: { id: string; role: string; parts: unknown[] };
    }) => void,
  ) => () => void;
  onSocketFlowExecutionEvent: (
    callback: (data: import('../shared/types/flow').FlowExecutionEvent) => void,
  ) => () => void;
  onSocketFlowChatReply: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      message: string;
      flowRunId: string;
      nodeRunId: string;
    }) => void,
  ) => () => void;
  onSubChatModeChanged: (
    callback: (data: { chatId: string; subChatId: string; mode: ChatMode }) => void,
  ) => () => void;
};
