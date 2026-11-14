/** The most bytes a file to import may have. Mirrors `MAX_IMPORT_*` in src-tauri/src/editor.rs. */
export const MAX_IMPORT_MB = 50;
/** The longest side of an image to import, in pixels. */
export const MAX_IMPORT_SIDE = 16_384;
/** The most pixels an image to import may have. */
export const MAX_IMPORT_PIXELS = 50_000_000;

/** An image the user gave the editor could not be used. */
export type ImportProblem =
  | { kind: 'ImageImportUnreadable' }
  | { kind: 'ImageImportFileTooLarge'; limit: number }
  | { kind: 'ImageImportTooLarge'; side: number; megapixels: number };

/** The file or blob as base64, without the `data:` prefix Rust does not expect. */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => { reject(reader.error ?? new Error('could not read the file')); };
    reader.readAsDataURL(file);
  });
}

/**
 * The file to open from a drop, a paste or a picker: the first image, or else the
 * first file, so that the error can say it is not a picture.
 */
export function pickImageFile(files: FileList | readonly File[]): File | undefined {
  const list = Array.from(files);
  return list.find((file) => file.type.startsWith('image/')) ?? list[0];
}

/**
 * Decodes `file` the way the renderer does (orientation and colour included),
 * checks its size and encodes it as PNG, the one format Rust accepts. The
 * result is the PNG as base64, or what is wrong with the file.
 */
export async function fileToPng(file: File): Promise<{ base64: string } | ImportProblem> {
  if (file.size > MAX_IMPORT_MB * 1024 * 1024) {
    return { kind: 'ImageImportFileTooLarge', limit: MAX_IMPORT_MB };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { kind: 'ImageImportUnreadable' };
  }
  try {
    const { width, height } = bitmap;
    if (width > MAX_IMPORT_SIDE || height > MAX_IMPORT_SIDE || width * height > MAX_IMPORT_PIXELS) {
      return {
        kind: 'ImageImportTooLarge',
        side: MAX_IMPORT_SIDE,
        megapixels: MAX_IMPORT_PIXELS / 1_000_000,
      };
    }
    const ctx = new OffscreenCanvas(width, height).getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    ctx.drawImage(bitmap, 0, 0);
    const png = await ctx.canvas.convertToBlob({ type: 'image/png' });
    return { base64: await readBase64(png) };
  } finally {
    bitmap.close();
  }
}
