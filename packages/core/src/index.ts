// @cropa/core: schema, renderer, colour and export presets.

export { clamp } from './math.ts';

export { Scene, migrateScene, defaultScene } from './schema/scene.ts';
export { BACKGROUND_VERSION, BackgroundSpec, migrateBackground } from './schema/background.ts';
export type { CodeLayer } from './schema/background.ts';
export { Annotation, migrateAnnotation } from './schema/annotation.ts';
export type { MigrateError, MigrateResult } from './schema/migrate.ts';
export {
  sceneJsonSchema,
  backgroundJsonSchema,
  annotationJsonSchema,
} from './schema/json-schema.ts';

export { render } from './render/render.ts';
export { frameGeometry, outputSize, outputSizeAtLongEdge, screenshotRect } from './render/layout.ts';
export type { FrameGeometry } from './render/layout.ts';
export { ANNOTATION_DEFAULTS, ANNOTATION_FONT } from './render/annotations.ts';
export { annotationBounds, hitTest } from './render/hit-test.ts';
export { isRedaction, redactScreenshot } from './render/redact.ts';
export { edgeColor } from './render/edge-color.ts';
export { extractPalette } from './colour/palette.ts';
export type { PaletteColour, PaletteOptions, Pixels } from './colour/palette.ts';
export { closestPreset } from './colour/closest-preset.ts';
export type { Canvas2D, CanvasImage, RenderEnv } from './render/canvas.ts';

export { PLATFORM_SIZES, PLATFORM_IDS, applyPlatformSize } from './export/platform-sizes.ts';
export type { PlatformId, PlatformSize } from './export/platform-sizes.ts';
export {
  PRESET_FILE_VERSION,
  PRESET_MAX_BYTES,
  PresetFile,
  PresetId,
  PresetName,
  migratePresetFile,
  importPreset,
  exportPreset,
  withoutCodeLayers,
  presetId,
  presetName,
} from './presets/file.ts';
export type { Preset, PresetError, PresetResult } from './presets/file.ts';
export { builtinPresets } from './presets/builtin.ts';
export { BUILTIN_IMAGES, communityPresetProblems, isBuiltinImage } from './presets/images.ts';
export type { BuiltinImage } from './presets/images.ts';
