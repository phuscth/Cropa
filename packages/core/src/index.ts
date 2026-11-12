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

export { PLATFORM_SIZES, PLATFORM_IDS, applyPlatformSize } from './export/platform-sizes.ts';
export type { PlatformId, PlatformSize } from './export/platform-sizes.ts';
