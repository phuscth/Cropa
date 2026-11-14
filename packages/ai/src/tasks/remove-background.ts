import { z } from 'zod';

import { defineTask } from '../task.ts';

export interface RemoveBackgroundInput {
  /** The screenshot as a PNG data URL. */
  image: string;
}

export interface RemoveBackgroundResult {
  /** The picture the provider made (a data URL); `null` keeps the image as it was. */
  cutout: string | null;
}

const PROMPT = `You remove the background of one picture. The picture is attached to this message; it is the only image in the conversation.

Use the image generation tool once to edit that attached picture into a cut-out of its main subject on a transparent background:
- Keep the subject exactly as it is: same position, same size, same proportions, same framing, same canvas aspect ratio. Do not crop, zoom, move, rotate, redraw, restyle, retouch, relight or add anything.
- Keep thin parts of the subject (hair, fur, whiskers, stems, cables, small text) and holes through it (gaps, letter counters, loops) as they are.
- Everything that is not the subject becomes fully transparent, including shadows cast on the background.
- If a transparent background is not possible, use one flat solid colour that does not appear in the subject instead.

Do not ask questions. After the image is made, reply with one word: done.`;

/**
 * Asks the provider's image tool for a cut-out of the picture's main subject. The answer is the
 * image; the reply text is ignored, so a run never sends a second attempt (a second image
 * costs quota). Nothing here throws `TaskOutputError`.
 */
export const removeBackgroundTask = defineTask({
  id: 'remove-background',
  version: 1,
  schema: z.unknown(),
  requires: ['image-in', 'image-out'],
  timeoutMs: 180_000,
  buildPrompt: (input: RemoveBackgroundInput) => ({
    system: '',
    user: PROMPT,
    images: [input.image],
  }),
  postprocess: (_output, { image }): RemoveBackgroundResult => ({ cutout: image ?? null }),
  fallback: (): RemoveBackgroundResult => ({ cutout: null }),
});
