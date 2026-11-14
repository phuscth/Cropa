import { useSyncExternalStore } from 'react';

/** The pages of the settings view, in the order of its sidebar. */
export const SETTINGS_SECTIONS = ['capture', 'appearance', 'general', 'ai', 'about'] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

// Kept in memory only: the view opens on the first page after a restart.
let current: SettingsSectionId = SETTINGS_SECTIONS[0];
const listeners = new Set<() => void>();

/** Show a page of the settings view, also before the view is first mounted (the Help menu's About). */
export function selectSettingsSection(section: SettingsSectionId): void {
  if (section === current) return;
  current = section;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The page of the settings view that is shown. */
export function useSettingsSection(): SettingsSectionId {
  return useSyncExternalStore(subscribe, () => current);
}
