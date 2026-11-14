import { redactScreenshot, type RenderEnv, type Scene } from '@cropa/core';

type Canvas = NonNullable<ReturnType<typeof redactScreenshot>>;

/**
 * The picture to send for a scene: the screenshot as it is, or, when the scene hides areas
 * with blur or pixelate, a PNG with those areas already applied at the screenshot's full size.
 * Redactions only exist in the scene, so sending the stored PNG would hand the hidden pixels to
 * the provider. `original` is the screenshot's PNG data URL; `encode` makes a PNG data URL of
 * a canvas.
 */
export async function pictureToSend(
  scene: Scene,
  env: RenderEnv,
  original: string,
  encode: (canvas: Canvas) => Promise<string>,
): Promise<string> {
  const redacted = redactScreenshot(scene, env);
  return redacted ? encode(redacted) : original;
}

/** A PNG data URL of an offscreen canvas. */
export async function canvasToPngDataUrl(canvas: Canvas): Promise<string> {
  if (!(canvas instanceof OffscreenCanvas)) throw new Error('the redacted picture is not an offscreen canvas');
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('the PNG could not be read'));
    };
    reader.onerror = () => { reject(new Error('the PNG could not be read')); };
    reader.readAsDataURL(blob);
  });
}
