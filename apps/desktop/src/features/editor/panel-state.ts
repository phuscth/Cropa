import { useSyncExternalStore } from 'react';

const CUSTOMIZE_KEY = 'cropa.editor.customize';
const CUSTOMIZE_VERSION = 1;

/** Whether the "Customize" section of the Background tab was left open; closed when unknown. */
export function readCustomizeOpen(): boolean {
  try {
    const raw = window.localStorage.getItem(CUSTOMIZE_KEY);
    if (raw === null) return false;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return false;
    const stored = value as { version?: unknown; open?: unknown };
    return stored.version === CUSTOMIZE_VERSION && stored.open === true;
  } catch {
    return false;
  }
}

export function writeCustomizeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(CUSTOMIZE_KEY, JSON.stringify({ version: CUSTOMIZE_VERSION, open }));
  } catch {
    // Storage may be unavailable; the section then starts closed next time.
  }
}

const SIDEBAR_KEY = 'cropa.editor.sidebar';
const SIDEBAR_VERSION = 1;

interface StoredSidebar {
  version: number;
  open: boolean;
}

/** Brings what was stored up to the current shape; anything unknown is the default, open. */
export function migrateSidebarState(value: unknown): StoredSidebar {
  const open = { version: SIDEBAR_VERSION, open: true };
  if (typeof value !== 'object' || value === null) return open;
  const stored = value as { version?: unknown; open?: unknown };
  if (stored.version === 1 && typeof stored.open === 'boolean') {
    return { version: SIDEBAR_VERSION, open: stored.open };
  }
  return open;
}

function readSidebar(): boolean {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_KEY);
    return raw === null ? true : migrateSidebarState(JSON.parse(raw)).open;
  } catch {
    return true;
  }
}

function writeSidebar(open: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ version: SIDEBAR_VERSION, open }));
  } catch {
    // Storage may be unavailable; the panel then starts open next time.
  }
}

let sidebarOpen = readSidebar();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether the editor's left panel is open. The title bar and the editor share it. */
export function useEditorSidebarOpen(): boolean {
  return useSyncExternalStore(subscribe, () => sidebarOpen);
}

export function setEditorSidebarOpen(next: boolean): void {
  if (next === sidebarOpen) return;
  sidebarOpen = next;
  writeSidebar(sidebarOpen);
  for (const listener of listeners) listener();
}

export function toggleEditorSidebar(): void {
  setEditorSidebarOpen(!sidebarOpen);
}
