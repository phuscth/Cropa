import { useSyncExternalStore } from 'react';

import { commands, type SettingsSection } from '../../lib/bindings.ts';

export type SettingsSectionId = SettingsSection;

/** The pages of the settings view, in the order of its sidebar. */
export const SETTINGS_SECTIONS = [
  'capture',
  'appearance',
  'general',
  'ai',
  'about',
] as const satisfies readonly SettingsSectionId[];

let current: SettingsSectionId = SETTINGS_SECTIONS[0];
// A page chosen in this window wins over the recorded one, which arrives later.
let chosen = false;
const listeners = new Set<() => void>();

function update(section: SettingsSectionId): void {
  if (section === current) return;
  current = section;
  for (const listener of listeners) listener();
}

/**
 * Show a page of the settings view, also before the view is first mounted (the
 * Help menu's About). The app keeps the choice in memory, so a main window that
 * is reopened after it was destroyed shows the same page.
 */
export function selectSettingsSection(section: SettingsSectionId): void {
  chosen = true;
  update(section);
  // Only the memory of the page is lost if this fails; the page is already shown.
  commands.setSettingsSection(section).catch(() => undefined);
}

// Read when the main window's page loads, before the settings view first shows: a window
// reopened after it was destroyed opens on the page last chosen instead of jumping to it.
commands
  .getSettingsSection()
  .then((recorded) => { if (!chosen) update(recorded); })
  .catch(() => undefined);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The page of the settings view that is shown. */
export function useSettingsSection(): SettingsSectionId {
  return useSyncExternalStore(subscribe, () => current);
}
