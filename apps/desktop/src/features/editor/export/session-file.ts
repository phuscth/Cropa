import type { SaveOutcome } from '../../../lib/bindings.ts';

/** The quick-saved file Ctrl+S may overwrite, tied to the image it was saved from. */
export interface SessionFile {
  /** The load counter of the editor image. */
  image: number;
  file: number | null;
}

export const initialSessionFile = (image: number): SessionFile => ({ image, file: null });

/** The id to pass as `sessionFile` when saving image `image`; null once the image changed. */
export function sessionFileFor(state: SessionFile, image: number): number | null {
  return state.image === image ? state.file : null;
}

/** The state after a quick save of image `image`: a cancelled save keeps it, a saved one records its id. */
export function afterQuickSave(state: SessionFile, image: number, outcome: SaveOutcome): SessionFile {
  const base = state.image === image ? state : initialSessionFile(image);
  return outcome.kind === 'saved' ? { image, file: outcome.file.id } : base;
}
