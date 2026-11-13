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
