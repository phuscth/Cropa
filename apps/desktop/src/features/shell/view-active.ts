import { createContext, useContext } from 'react';

/**
 * Whether the view that renders this is the one on screen. The main window
 * keeps every visited view mounted and hides the others, so window-level
 * listeners and refreshes must follow this flag instead of the mount.
 */
export const ViewActiveContext = createContext(true);

export function useViewActive(): boolean {
  return useContext(ViewActiveContext);
}
