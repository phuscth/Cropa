import { isRedaction, redactScreenshot, type RenderEnv, type Scene } from '@cropa/core';

/** The redaction annotations as JSON, in order; empty when there are none. */
export function redactionKey(scene: Scene): string {
  const redactions = scene.annotations.filter(isRedaction);
  return redactions.length === 0 ? '' : JSON.stringify(redactions);
}

/**
 * Remembers the redacted copy of the screenshot, so a preview frame that changes
 * only the frame, the background or a vector annotation does not recompute every
 * blur and pixelate. The renderer draws the same pixels either way. One entry:
 * the copy is reused while the redactions and the screenshot are unchanged.
 */
export function createRedactionCache() {
  let key = '';
  let source: RenderEnv['screenshot'] | undefined;
  let redacted: RenderEnv['screenshot'] | null = null;

  return {
    scene(scene: Scene, env: RenderEnv): { scene: Scene; env: RenderEnv } {
      const next = redactionKey(scene);
      if (next === '') return { scene, env };
      if (next !== key || source !== env.screenshot) {
        redacted = redactScreenshot(scene, env);
        key = next;
        source = env.screenshot;
      }
      if (!redacted) return { scene, env };
      return {
        scene: { ...scene, annotations: scene.annotations.filter((a) => !isRedaction(a)) },
        env: { ...env, screenshot: redacted },
      };
    },
  };
}
