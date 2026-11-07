import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { NormalizedMessage, Project, ProjectSession, QuickSettingsTab, SlashCommand } from '@/shared/types';

//----------------- DATE AND TIME DISPLAY ------------

/** Formats UI/export timestamps in local time using 00–23 hours regardless of browser or language preferences. */
export function formatDateTime24(
  value: Date | string | number,
  options: Omit<Intl.DateTimeFormatOptions, 'hour12' | 'hourCycle'> = {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  },
  locales?: string | string[],
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locales, { ...options, hourCycle: 'h23' }).format(date);
}

// ---------------------------

//----------------- CHAT TRANSCRIPT BOUNDARY ------------

/** Kinds that represent displayable transcript rows, rather than protocol control frames. */
const STORED_CHAT_MESSAGE_KINDS = new Set([
  'text', 'tool_use', 'tool_result', 'thinking', 'stream_delta', 'error',
  'session_created', 'task_notification', 'task_status',
]);

/** Rejects control frames and malformed rows before they can enter chat history. */
export function isStorableChatMessage(value: unknown): value is NormalizedMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && row.id.length > 0
    && typeof row.kind === 'string' && STORED_CHAT_MESSAGE_KINDS.has(row.kind)
    && typeof row.timestamp === 'string' && row.timestamp.length > 0
    && typeof row.provider === 'string' && row.provider.length > 0;
}

// ---------------------------

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

/** Returns the backend pinned into this page by Hub's HTML wrapper or backend-specific URL. */
export function getHubBackendId(): string | null {
  // Hub is one workspace. Backend selection belongs to resources, never the page.
  return null;
}

/** Detects the Hub-served CloudCLI application even when a static frontend host omits Hub's runtime injection script. */
export function isHubRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const injected = (window as Window & { __CLOUDCLI_BACKEND_ID__?: string }).__CLOUDCLI_BACKEND_ID__;
  return Boolean(injected)
    || new URLSearchParams(window.location.search).has('hub_backend')
    || window.location.pathname === '/cloudcli'
    || window.location.pathname.startsWith('/cloudcli/');
}

const HUB_RESOURCE_BACKENDS = new Map<string, string>();

/** Associate a project or session ID with the Hub server that owns its data. */
export function registerHubResourceBackend(kind: 'project' | 'session', resourceId: string, backendId: string): void {
  if (resourceId && backendId) HUB_RESOURCE_BACKENDS.set(`${kind}:${resourceId}`, backendId);
}

/** Resolve the owning server for an already-loaded project or session ID. */
export function getHubResourceBackend(kind: 'project' | 'session', resourceId: string | null | undefined): string | null {
  if (!resourceId) return null;
  return HUB_RESOURCE_BACKENDS.get(`${kind}:${resourceId}`) ?? null;
}

/** Infer a project or session owner from common CloudCLI API path, query and JSON-body shapes. */
export function getHubRequestBackend(url: string, body?: BodyInit | null): string | null {
  if (typeof window === 'undefined') return null;
  const parsed = new URL(url, window.location.origin);
  const projectPath = parsed.pathname.match(/^\/api\/(?:projects|file-tree\/projects)\/([^/]+)/);
  if (projectPath) {
    const backendId = getHubResourceBackend('project', decodeURIComponent(projectPath[1]));
    if (backendId) return backendId;
  }
  const sessionPath = parsed.pathname.match(/^\/api\/(?:providers\/(?:[^/]+\/)?sessions)\/([^/]+)/);
  if (sessionPath) {
    const backendId = getHubResourceBackend('session', decodeURIComponent(sessionPath[1]));
    if (backendId) return backendId;
  }
  const projectQuery = parsed.searchParams.get('project') ?? parsed.searchParams.get('projectId');
  const projectBackend = getHubResourceBackend('project', projectQuery);
  if (projectBackend) return projectBackend;
  const sessionQuery = parsed.searchParams.get('sessionId');
  const sessionBackend = getHubResourceBackend('session', sessionQuery);
  if (sessionBackend) return sessionBackend;
  if (body instanceof FormData) {
    const projectId = body.get('projectId');
    return typeof projectId === 'string' ? getHubResourceBackend('project', projectId) : null;
  }
  if (typeof body !== 'string') return null;
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const scope = typeof payload.scope === 'string' ? payload.scope : null;
    if (scope) {
      const owner = scope.startsWith('project:')
        ? getHubResourceBackend('project', scope.slice(8))
        : getHubResourceBackend('session', scope);
      if (owner) return owner;
    }
    const projectId = typeof payload.projectId === 'string'
      ? payload.projectId
      : typeof payload.project === 'string' ? payload.project : null;
    const backendFromProject = getHubResourceBackend('project', projectId);
    if (backendFromProject) return backendFromProject;
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
    return getHubResourceBackend('session', sessionId);
  } catch {
    return null;
  }
}

/** Namespaces a browser cache or credential by backend while retaining legacy keys outside Hub. */
export function getHubStorageKey(key: string, backendId?: string | null): string {
  if (isHubRuntime()) {
    let accountId = 'signed-out';
    try {
      const token = localStorage.getItem('auth-token:hub');
      if (token) {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (typeof payload.hubUserId === 'string') accountId = payload.hubUserId;
      }
    } catch { /* Unauthenticated caches never share a signed-in account key. */ }
    return `${key}:hub:${accountId}`;
  }
  return backendId ? `${key}:${backendId}` : key;
}

/** Pins an API, EventSource, or WebSocket URL to this page's backend, including across other-tab switches. */
export function withHubBackendUrl(url: string, backendId = getHubBackendId()): string {
  if (!backendId) return url;
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set('hub_backend', backendId);
  return url.startsWith('http:') || url.startsWith('https:') || url.startsWith('ws:') || url.startsWith('wss:')
    ? parsed.toString()
    : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'CloudCLI UI';

/**
 * Resolves the human-readable label for a session: the persisted `summary` (the custom
 * name the sessions API returns for every provider, Cursor included), else the `name` a
 * Cursor session object may carry locally, else the provider's placeholder. Reads the
 * same fields in the same order as the sidebar row, so the header, document title and
 * sidebar never disagree about a session's name.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  const title = (session.summary as string) || (session.name as string);
  if (session.__provider === 'cursor') {
    return title || 'Untitled Session';
  }

  return title || 'New Session';
};

/**
 * Keeps Electron titled CloudCLI; builds the browser title from the current selection when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (typeof window !== 'undefined' && ('cloudcliDesktopUpdates' in window && window.cloudcliDesktopUpdates)) {
    return 'CloudCLI';
  }

  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

// ---------------------------

//----------------- SLASH COMMANDS ------------

/**
 * Whether a slash command is a provider skill (as opposed to a built-in or a
 * custom `.md` command). Skills are mapped with `type: 'skill'`; the metadata
 * check catches entries that only carry the skill marker there. Used wherever
 * commands are grouped or executed differently by kind.
 */
export const isSkillCommand = (command: SlashCommand): boolean =>
  command.type === 'skill' || command.metadata?.type === 'skill';

// ---------------------------

//----------------- QUICK SETTINGS PANEL ------------

/** DOM id of a quick settings tab button; pairs with `getQuickSettingsTabPanelId` for aria-controls / aria-labelledby. */
export const getQuickSettingsTabId = (tab: QuickSettingsTab): string => `quick-settings-tab-${tab}`;

/** DOM id of the tabpanel a quick settings tab controls; pairs with `getQuickSettingsTabId`. */
export const getQuickSettingsTabPanelId = (tab: QuickSettingsTab): string => `quick-settings-tabpanel-${tab}`;

//----------------- SESSION PAGE LINKS ------------

/** Builds a session deep link while retaining the deployed app prefix and current origin. Used by sidebar menus and recents links. */
export function getSessionPageUrl(sessionId: string): string {
  const url = new URL(window.location.href);
  url.pathname = `${url.pathname.split('/session/')[0].replace(/\/$/, '')}/session/${encodeURIComponent(sessionId)}`;
  return url.href;
}

//----------------- CHAT SEND RESULT OWNERSHIP ------------

// Only live requests are retained; every receipt, timeout and failed local send releases its claim.
const ownedChatSendResults = new Set<string>();

/** The chat composer claims request-level protocol errors while it decides acceptance or durable queue fallback. */
export function claimChatSendResult(clientMessageId: string): () => void {
  ownedChatSendResults.add(clientMessageId);
  return () => { ownedChatSendResults.delete(clientMessageId); };
}

/** Realtime chat rendering defers owned failures to their send controller, avoiding premature duplicate errors. */
export function isChatSendResultOwned(clientMessageId: unknown): boolean {
  return typeof clientMessageId === 'string' && ownedChatSendResults.has(clientMessageId);
}
