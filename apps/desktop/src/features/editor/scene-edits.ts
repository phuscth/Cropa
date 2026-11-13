import {
  applyPlatformSize,
  clamp,
  migrateScene,
  type BackgroundSpec,
  type PlatformId,
  type Scene,
} from '@cropa/core';

type Layer = BackgroundSpec['layers'][number];
type Frame = Scene['frame'];

/** The editor's image layer `ref` for the screenshot itself. */
export const CAPTURE_REF = 'builtin:capture';

/** Blur radius given to a background made of the capture, so it reads as a backdrop. */
const IMAGE_BLUR = 24;
const FALLBACK_COLORS = ['#6366f1', '#ec4899'];
const VIEW = 1000;
/** The solid layer that stands for "no background". */
const NO_BACKGROUND = '#00000000';

/**
 * Returns `next` when it is a valid scene within the output size limit, else
 * `prev`. Every edit the editor applies goes through this, so the scene in
 * state is always valid.
 */
export function accept(prev: Scene, next: Scene): Scene {
  return tryAccept(prev, next) ?? prev;
}

/** Like `accept`, but null tells a rejected change apart from one that changed nothing. */
export function tryAccept(prev: Scene, next: Scene): Scene | null {
  if (next === prev) return prev;
  return migrateScene(next).ok ? next : null;
}

// ---------------------------------------------------------------- background

export type BackgroundKind = 'none' | 'solid' | 'linear' | 'radial' | 'conic' | 'mesh' | 'image';

export const BACKGROUND_KINDS: readonly BackgroundKind[] = [
  'none',
  'solid',
  'linear',
  'radial',
  'conic',
  'mesh',
  'image',
];

const MAIN_TYPES = new Set<string>(['solid', 'linear', 'radial', 'conic', 'mesh', 'image']);

type MainLayer = Extract<Layer, { type: BackgroundKind }>;

/** The last layer that paints the background itself; noise, shapes and blur sit on top. */
function mainIndex(spec: BackgroundSpec): number {
  return spec.layers.findLastIndex((layer) => MAIN_TYPES.has(layer.type));
}

function mainLayer(spec: BackgroundSpec): MainLayer | undefined {
  const layer = spec.layers[mainIndex(spec)];
  return layer && MAIN_TYPES.has(layer.type) ? (layer as MainLayer) : undefined;
}

export function backgroundKind(spec: BackgroundSpec): BackgroundKind {
  const layer = mainLayer(spec);
  if (!layer) return 'none';
  if (spec.layers.length === 1 && layer.type === 'solid' && layer.color.toLowerCase() === NO_BACKGROUND) {
    return 'none';
  }
  return layer.type;
}

export function backgroundColors(spec: BackgroundSpec): string[] {
  if (backgroundKind(spec) === 'none') return [];
  const layer = mainLayer(spec);
  switch (layer?.type) {
    case 'solid':
      return [layer.color];
    case 'linear':
    case 'radial':
    case 'conic':
      return layer.stops.map((stop) => stop.color);
    case 'mesh':
      return layer.points.map((point) => point.color);
    default:
      return [];
  }
}

export function backgroundAngle(spec: BackgroundSpec): number | null {
  const layer = mainLayer(spec);
  return layer?.type === 'linear' || layer?.type === 'conic' ? layer.angle : null;
}

const trailingBlur = (spec: BackgroundSpec) => {
  const last = spec.layers.at(-1);
  return last?.type === 'blur' ? last : undefined;
};

export function backgroundBlur(spec: BackgroundSpec): number {
  return trailingBlur(spec)?.radius ?? 0;
}

const withBackground = (scene: Scene, background: BackgroundSpec): Scene => ({
  ...scene,
  background,
});

const withLayers = (scene: Scene, layers: Layer[]): Scene =>
  withBackground(scene, { ...scene.background, layers });

function hexAverage(colors: string[]): string {
  const channel = (offset: number) =>
    Math.round(
      colors.reduce((sum, color) => sum + parseInt(color.slice(offset, offset + 2), 16), 0) /
        Math.max(1, colors.length),
    )
      .toString(16)
      .padStart(2, '0');
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

function evenStops(colors: string[]) {
  return colors.map((color, i) => ({ offset: i / (colors.length - 1), color }));
}

/** Switches the main layer to `kind`, keeping its colours and dropping any decoration layers. */
export function setBackgroundKind(scene: Scene, kind: BackgroundKind): Scene {
  const spec = scene.background;
  if (backgroundKind(spec) === kind) return scene;
  const seed = backgroundColors(spec);
  const color = (i: number): string =>
    seed.length > 0
      ? (seed[i % seed.length] ?? '#6366f1')
      : (FALLBACK_COLORS[i % FALLBACK_COLORS.length] ?? '#6366f1');
  const blur = backgroundBlur(spec);

  const layers: Layer[] = [];
  switch (kind) {
    case 'none':
      layers.push({ type: 'solid', color: NO_BACKGROUND });
      break;
    case 'solid':
      layers.push({ type: 'solid', color: color(0) });
      break;
    case 'linear':
      layers.push({ type: 'linear', angle: 135, stops: evenStops([color(0), color(1)]) });
      break;
    case 'radial':
      layers.push({
        type: 'radial',
        cx: VIEW / 2,
        cy: VIEW / 2,
        r: 710,
        stops: evenStops([color(0), color(1)]),
      });
      break;
    case 'conic':
      // The last stop repeats the first, so the sweep has no seam.
      layers.push({
        type: 'conic',
        cx: VIEW / 2,
        cy: VIEW / 2,
        angle: 0,
        stops: evenStops([color(0), color(1), color(0)]),
      });
      break;
    case 'mesh': {
      const colors = [0, 1, 2, 3].map(color);
      layers.push(
        { type: 'solid', color: hexAverage(colors) },
        {
          type: 'mesh',
          points: [
            [0, 0],
            [VIEW, 0],
            [VIEW, VIEW],
            [0, VIEW],
          ].map(([x, y], i) => ({ x: x ?? 0, y: y ?? 0, r: VIEW, color: colors[i] ?? color(0) })),
        },
      );
      break;
    }
    case 'image':
      layers.push({ type: 'image', ref: CAPTURE_REF, fit: 'cover' });
      break;
  }
  const radius = kind === 'image' && blur === 0 ? IMAGE_BLUR : kind === 'none' ? 0 : blur;
  if (radius > 0) layers.push({ type: 'blur', radius });
  return withBackground(scene, { ...spec, viewBox: [0, 0, VIEW, VIEW], layers });
}

/** Sets colour number `index` of the main layer, in place. */
export function setBackgroundColor(scene: Scene, index: number, hex: string): Scene {
  const spec = scene.background;
  const at = mainIndex(spec);
  const layer = mainLayer(spec);
  if (!layer || backgroundKind(spec) === 'none' || !Number.isInteger(index)) return scene;
  if (backgroundColors(spec)[index] === undefined || backgroundColors(spec)[index] === hex) {
    return scene;
  }

  const layers = [...spec.layers];
  switch (layer.type) {
    case 'solid':
      layers[at] = { ...layer, color: hex };
      break;
    case 'linear':
    case 'radial':
    case 'conic':
      layers[at] = {
        ...layer,
        stops: layer.stops.map((stop, i) => (i === index ? { ...stop, color: hex } : stop)),
      };
      break;
    case 'mesh': {
      const points = layer.points.map((point, i) => (i === index ? { ...point, color: hex } : point));
      layers[at] = { ...layer, points };
      const below = layers[at - 1];
      if (below?.type === 'solid') {
        layers[at - 1] = { ...below, color: hexAverage(points.map((p) => p.color)) };
      }
      break;
    }
    case 'image':
      return scene;
  }
  return withLayers(scene, layers);
}

/** Linear and conic backgrounds only; degrees 0..360. */
export function setBackgroundAngle(scene: Scene, degrees: number): Scene {
  const spec = scene.background;
  const at = mainIndex(spec);
  const layer = mainLayer(spec);
  if (layer?.type !== 'linear' && layer?.type !== 'conic') return scene;
  const angle = clamp(Math.round(degrees), 0, 360);
  if (layer.angle === angle) return scene;
  const layers = [...spec.layers];
  layers[at] = { ...layer, angle };
  return withLayers(scene, layers);
}

/** 0 removes the trailing blur layer; any other radius replaces it or adds one. */
export function setBackgroundBlur(scene: Scene, radius: number): Scene {
  const spec = scene.background;
  if (backgroundKind(spec) === 'none') return scene;
  const r = clamp(Math.round(radius), 0, 100);
  if (backgroundBlur(spec) === r) return scene;
  const layers = trailingBlur(spec) ? spec.layers.slice(0, -1) : [...spec.layers];
  if (r > 0) {
    if (layers.length >= 16) return scene;
    layers.push({ type: 'blur', radius: r });
  }
  return withLayers(scene, layers);
}

/** A plain background of `hex`, for a screenshot whose edge colour is known. */
export function matchImageColor(scene: Scene, hex: string): Scene {
  return withBackground(scene, {
    ...scene.background,
    viewBox: [0, 0, VIEW, VIEW],
    layers: [{ type: 'solid', color: hex }],
  });
}

// --------------------------------------------------------------------- frame

const longestSide = (scene: Scene) => Math.max(scene.screenshot.width, scene.screenshot.height);

function withFrame(scene: Scene, patch: Partial<Frame>): Scene {
  const changed = (Object.keys(patch) as (keyof Frame)[]).some(
    (key) => JSON.stringify(patch[key]) !== JSON.stringify(scene.frame[key]),
  );
  return changed ? { ...scene, frame: { ...scene.frame, ...patch } } : scene;
}

export function setPadding(scene: Scene, value: number): Scene {
  return withFrame(scene, { padding: clamp(Math.round(value), 0, 8192) });
}

export function setRadius(scene: Scene, value: number): Scene {
  return withFrame(scene, { radius: clamp(Math.round(value), 0, 4096) });
}

export function setInset(scene: Scene, value: number): Scene {
  return withFrame(scene, { inset: clamp(Math.round(value), 0, 4096) });
}

/** `'auto'` takes the colour at the screenshot's edges; anything else is a hex colour. */
export function setInsetColor(scene: Scene, color: string): Scene {
  return withFrame(scene, { insetColor: color });
}

/**
 * Width 0 removes the border; otherwise the colour is kept. When there is no border,
 * `fallbackColor` is used, so a drag through 0 can bring back the colour it had.
 */
export function setBorderWidth(scene: Scene, width: number, fallbackColor = '#ffffff'): Scene {
  const w = clamp(Math.round(width), 0, 512);
  if (w === 0) return withFrame(scene, { border: null });
  return withFrame(scene, { border: { color: scene.frame.border?.color ?? fallbackColor, width: w } });
}

/** Without a border, this adds a thin one scaled to the screenshot. */
export function setBorderColor(scene: Scene, hex: string): Scene {
  const width = scene.frame.border?.width ?? Math.max(1, Math.round(longestSide(scene) * 0.002));
  return withFrame(scene, { border: { width, color: hex } });
}

export type ShadowLevel = 'none' | 'soft' | 'medium' | 'strong';

export const SHADOW_LEVELS: readonly ShadowLevel[] = ['none', 'soft', 'medium', 'strong'];

/** Medium is the shadow `defaultScene` draws; soft and strong are about half and twice it. */
export function shadowsFor(
  level: ShadowLevel,
  size: { width: number; height: number },
): Frame['shadows'] {
  const m = Math.max(size.width, size.height);
  const layer = (offset: number, blur: number, alpha: string, k: number) => ({
    x: 0,
    y: Math.round(m * offset * k),
    blur: Math.min(2048, Math.round(m * blur * k)),
    color: `#000000${alpha}`,
  });
  switch (level) {
    case 'none':
      return [];
    case 'soft':
      return [layer(0.01, 0.03, '26', 0.5), layer(0.002, 0.006, '12', 0.5)];
    case 'medium':
      return [layer(0.01, 0.03, '40', 1), layer(0.002, 0.006, '1f', 1)];
    case 'strong':
      return [layer(0.01, 0.03, '66', 2), layer(0.002, 0.006, '2e', 2)];
  }
}

/** The level the scene's shadows match, or null when they match none. */
export function shadowLevel(scene: Scene): ShadowLevel | null {
  const current = JSON.stringify(scene.frame.shadows);
  return (
    SHADOW_LEVELS.find((level) => JSON.stringify(shadowsFor(level, scene.screenshot)) === current) ??
    null
  );
}

export function setShadowLevel(scene: Scene, level: ShadowLevel): Scene {
  return withFrame(scene, { shadows: shadowsFor(level, scene.screenshot) });
}

/** Slider ranges in screenshot pixels, relative to the screenshot so they feel alike at any size. */
export function frameRanges(size: { width: number; height: number }) {
  const m = Math.max(size.width, size.height);
  const range = (max: number): [number, number] => [0, max];
  return {
    padding: range(Math.round(m * 0.25)),
    radius: range(Math.max(8, Math.round(Math.min(size.width, size.height) * 0.1))),
    inset: range(Math.round(m * 0.05)),
    border: range(Math.max(4, Math.round(m * 0.01))),
  };
}

// -------------------------------------------------------------------- aspect

export type AspectPreset = 'auto' | '1:1' | '4:3' | '16:9' | '9:16' | 'custom';

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  'auto',
  '1:1',
  '4:3',
  '16:9',
  '9:16',
  'custom',
];

const RATIOS: Record<Exclude<AspectPreset, 'auto' | 'custom'>, [number, number]> = {
  '1:1': [1, 1],
  '4:3': [4, 3],
  '16:9': [16, 9],
  '9:16': [9, 16],
};

/** Sets the ratio; a plain ratio also leaves a platform size, whose output has a fixed width. */
export function setAspectRatio(scene: Scene, ratio: [number, number] | null): Scene {
  const current = scene.output.aspectRatio;
  if (scene.output.width === null) {
    if (current === null && ratio === null) return scene;
    if (current && ratio && current[0] === ratio[0] && current[1] === ratio[1]) return scene;
  }
  return { ...scene, output: { aspectRatio: ratio, width: null } };
}

/** Frames the scene for a platform; the same scene back when it already is. */
export function setPlatformSize(scene: Scene, id: PlatformId): Scene {
  const next = applyPlatformSize(scene, id);
  return sameOutput(scene, next) ? scene : next;
}

/** True when the scene's output is the size of platform `id`. */
export function platformMatches(scene: Scene, id: PlatformId): boolean {
  return sameOutput(scene, applyPlatformSize(scene, id));
}

function sameOutput(a: Scene, b: Scene): boolean {
  const ra = a.output.aspectRatio;
  const rb = b.output.aspectRatio;
  if (a.output.width !== b.output.width) return false;
  if (ra === null || rb === null) return ra === rb;
  return Math.abs(ra[0] - rb[0]) < 1e-9 && Math.abs(ra[1] - rb[1]) < 1e-9;
}

/** The ratio of a preset; null for `auto` and `custom`. */
export function presetRatio(preset: AspectPreset): [number, number] | null {
  return preset === 'auto' || preset === 'custom' ? null : [...RATIOS[preset]];
}

export function aspectPreset(scene: Scene): AspectPreset {
  const ratio = scene.output.aspectRatio;
  if (!ratio) return 'auto';
  for (const [name, [w, h]] of Object.entries(RATIOS)) {
    if (Math.abs(ratio[0] * h - ratio[1] * w) < 1e-9) return name as AspectPreset;
  }
  return 'custom';
}

// ---------------------------------------------------------------- presets

/** True when two backgrounds are the same by value. */
export function sameBackground(a: BackgroundSpec, b: BackgroundSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Replaces only the background; the same scene back when it already has it. */
export function applyBackground(scene: Scene, background: BackgroundSpec): Scene {
  return sameBackground(scene.background, background) ? scene : { ...scene, background };
}

/** The plain colour that stands in for an image that can't be found. */
const MISSING_IMAGE_COLOR = '#d4d4d8';

/** Every image ref the background draws, without repeats; the screenshot itself is not one. */
export function backgroundImageRefs(spec: BackgroundSpec): string[] {
  const refs = spec.layers.flatMap((layer) => (layer.type === 'image' ? [layer.ref] : []));
  return [...new Set(refs)].filter((ref) => ref !== CAPTURE_REF);
}

/** The ref of the image the background is made of, or null when it is not an image background. */
export function backgroundImageRef(spec: BackgroundSpec): string | null {
  const layer = mainLayer(spec);
  return backgroundKind(spec) === 'image' && layer?.type === 'image' ? layer.ref : null;
}

/**
 * Makes the background the image `ref`, covering the frame. On an image background
 * it keeps the blur and any opacity; from any other kind it starts with the blur that
 * suits the image: a soft backdrop for the screenshot, none for a picture.
 */
export function setBackgroundImage(scene: Scene, ref: string): Scene {
  const spec = scene.background;
  const layer = mainLayer(spec);
  if (backgroundKind(spec) === 'image' && layer?.type === 'image') {
    if (layer.ref === ref && layer.fit === 'cover') return scene;
    const layers = [...spec.layers];
    layers[mainIndex(spec)] = { ...layer, ref, fit: 'cover' };
    return withLayers(scene, layers);
  }
  const layers: Layer[] = [{ type: 'image', ref, fit: 'cover' }];
  if (ref === CAPTURE_REF) layers.push({ type: 'blur', radius: IMAGE_BLUR });
  return withBackground(scene, { ...spec, viewBox: [0, 0, VIEW, VIEW], layers });
}

/**
 * The background with every image layer whose ref is in `missing` replaced by a plain
 * grey layer of the same opacity, so the preview and the export agree and nothing is
 * left transparent.
 */
export function withoutMissingImages(spec: BackgroundSpec, missing: readonly string[]): BackgroundSpec {
  if (missing.length === 0) return spec;
  return {
    ...spec,
    layers: spec.layers.map((layer): Layer =>
      layer.type === 'image' && missing.includes(layer.ref)
        ? {
            type: 'solid',
            color: MISSING_IMAGE_COLOR,
            ...(layer.opacity === undefined ? {} : { opacity: layer.opacity }),
          }
        : layer,
    ),
  };
}
