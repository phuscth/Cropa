let context: OffscreenCanvasRenderingContext2D | null | undefined;

/** Text width for hit testing and bounds, measured with the font the renderer uses. */
export function measureText(text: string, font: string): number {
  context ??= new OffscreenCanvas(1, 1).getContext('2d');
  if (!context) return text.length * 8;
  context.font = font;
  return context.measureText(text).width;
}
