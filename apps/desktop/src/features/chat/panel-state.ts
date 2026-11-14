import { useSyncExternalStore } from 'react';

const KEY = 'cropa.editor.chat';
const VERSION = 1;

interface StoredPanel {
  version: number;
  open: boolean;
}

/** Brings what was stored up to the current shape; anything unknown is the default, closed. */
export function migratePanelState(value: unknown): StoredPanel {
  const closed = { version: VERSION, open: false };
  if (typeof value !== 'object' || value === null) return closed;
  const stored = value as { version?: unknown; open?: unknown };
  if (stored.version === 1 && typeof stored.open === 'boolean') {
    return { version: VERSION, open: stored.open };
  }
  return closed;
}

function read(): boolean {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? false : migratePanelState(JSON.parse(raw)).open;
  } catch {
    return false;
  }
}

function write(open: boolean): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ version: VERSION, open }));
  } catch {
    // Storage may be unavailable; the panel then starts closed next time.
  }
}

let open = read();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether the chat panel is open. The title bar and the editor share it. */
export function useChatPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

export function setChatPanelOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  write(open);
  for (const listener of listeners) listener();
}

export function toggleChatPanel(): void {
  setChatPanelOpen(!open);
}
