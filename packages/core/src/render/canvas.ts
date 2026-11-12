// The part of the 2D canvas API the renderer uses, declared structurally so that
// this package needs no DOM types. The WebView's CanvasRenderingContext2D and
// OffscreenCanvasRenderingContext2D, and @napi-rs/canvas in Node, all satisfy it.

/** Anything a 2D context can draw: an ImageBitmap, an OffscreenCanvas, an <img>, or a Node canvas or image. */
export interface CanvasImage {
  readonly width: number;
  readonly height: number;
}

export interface CanvasGradientLike {
  addColorStop(offset: number, color: string): void;
}

export interface PixelData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface Canvas2D {
  readonly canvas: CanvasImage;
  // Only ever written by the renderer; the type stays loose so DOM and Skia types both fit.
  fillStyle: string | object;
  strokeStyle: string | object;
  globalAlpha: number;
  globalCompositeOperation: string;
  filter: string;
  imageSmoothingEnabled: boolean;
  shadowBlur: number;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  font: string;
  textAlign: string;
  textBaseline: string;

  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  rotate(angle: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;

  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { readonly width: number };

  drawImage(image: object, dx: number, dy: number, dw: number, dh: number): void;
  drawImage(
    image: object,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradientLike;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradientLike;
  createConicGradient(startAngle: number, x: number, y: number): CanvasGradientLike;

  createImageData(width: number, height: number): PixelData;
  putImageData(data: object, dx: number, dy: number): void;
  getImageData(x: number, y: number, w: number, h: number): PixelData;
}

export interface RenderEnv {
  /** The captured image in physical pixels. */
  screenshot: CanvasImage;
  /** Resolves an image layer's `ref`. A missing image skips that layer. */
  image?: (ref: string) => CanvasImage | undefined;
  /**
   * Creates an offscreen 2D context: `new OffscreenCanvas(w, h).getContext('2d')` in the
   * WebView, `createCanvas(w, h).getContext('2d')` in Node.
   */
  createContext(width: number, height: number): Canvas2D;
}
