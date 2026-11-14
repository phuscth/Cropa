import { createContext, useContext } from 'react';

import type { MainView } from '../../lib/bindings.ts';

/**
 * Whether the view that renders this is the one on screen. The main window
 * keeps every visited view mounted and hides the others, so window-level
 * listeners and refreshes must follow this flag instead of the mount.
 */
export const ViewActiveContext = createContext(true);

export function useViewActive(): boolean {
  return useContext(ViewActiveContext);
}

/** Switches the main window to another view; a view uses it to send the user somewhere else. */
export const ShowViewContext = createContext<(view: MainView) => void>(() => undefined);

export function useShowView(): (view: MainView) => void {
  return useContext(ShowViewContext);
}
