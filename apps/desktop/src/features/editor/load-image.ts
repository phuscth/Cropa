/**
 * Decodes an image from a `data:` URL. The CSP has no `data:` in `connect-src`,
 * so this goes through an <img> element, not `fetch`.
 */
export async function dataUrlToBitmap(url: string): Promise<ImageBitmap> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return createImageBitmap(img);
}
