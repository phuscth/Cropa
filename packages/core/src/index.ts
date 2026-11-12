// @cropa/core: schema, renderer, colour and export presets.

export { clamp } from './math.ts';

export { Scene, migrateScene, defaultScene } from './schema/scene.ts';
export { BackgroundSpec, migrateBackground } from './schema/background.ts';
export { Annotation, migrateAnnotation } from './schema/annotation.ts';
export type { MigrateError, MigrateResult } from './schema/migrate.ts';
export {
  sceneJsonSchema,
  backgroundJsonSchema,
  annotationJsonSchema,
} from './schema/json-schema.ts';

export { render } from './render/render.ts';
export { outputSize } from './render/layout.ts';
export { edgeColor } from './render/edge-color.ts';
export type { Canvas2D, CanvasImage, RenderEnv } from './render/canvas.ts';

export {
  PRESET_FILE_VERSION,
  PRESET_MAX_BYTES,
  PresetFile,
  PresetId,
  PresetName,
  migratePresetFile,
  importPreset,
  exportPreset,
  presetId,
  presetName,
} from './presets/file.ts';
export type { Preset, PresetError, PresetResult } from './presets/file.ts';
export { builtinPresets } from './presets/builtin.ts';
