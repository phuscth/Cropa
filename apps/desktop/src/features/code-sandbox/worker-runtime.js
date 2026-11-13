// Runs first in the sandbox worker, before the AI module. It is concatenated with the module into one
// classic script, so it must stay free of import and export.
const post = self.postMessage.bind(self);
const listen = self.addEventListener.bind(self);

// Without these a module could leave nested busy workers running after the sandbox is terminated.
delete self.Worker;
delete self.SharedWorker;

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function fail(kind, message) {
  post({ type: 'loaded', error: { kind, message } });
}

function checkModule(mod) {
  if (typeof mod.back !== 'function') {
    return 'The module must declare a function back(ctx, t, scene) at top level.';
  }
  if (mod.front !== undefined && typeof mod.front !== 'function') {
    return 'front must be a function front(ctx, t, scene) when it is declared.';
  }
  const meta = mod.meta;
  if (meta === null || typeof meta !== 'object') {
    return 'The module must declare const meta = { durationMs: 4000 } at top level.';
  }
  const ms = meta.durationMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 250 || ms > 60000) {
    return `meta.durationMs must be a number of milliseconds from 250 to 60000, got ${JSON.stringify(ms) ?? String(ms)}.`;
  }
  return null;
}

function hasWebgl() {
  if (typeof OffscreenCanvas === 'undefined') return false;
  const canvas = new OffscreenCanvas(1, 1);
  return (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) !== null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- called by the script that wraps the AI module
function __cropaStart(mod, loadError, needsWebgl) {
  if (loadError) {
    fail('module-error', describeError(loadError));
    return;
  }
  const problem = checkModule(mod);
  if (problem) {
    fail('module-error', problem);
    return;
  }
  if (needsWebgl && !hasWebgl()) {
    fail('no-webgl', 'WebGL is not available here, so a module that uses THREE cannot run. Draw with the 2D canvas instead.');
    return;
  }
  post({ type: 'loaded', durationMs: mod.meta.durationMs, hasFront: typeof mod.front === 'function' });

  const canvases = { back: null, front: null };

  // The module can resize ctx.canvas, so the real canvas is compared with the scene before every call.
  function canvasFor(key, scene) {
    let canvas = canvases[key];
    if (canvas === null || canvas.width !== scene.width || canvas.height !== scene.height) {
      canvas = new OffscreenCanvas(scene.width, scene.height);
      canvases[key] = canvas;
    }
    return canvas;
  }

  function render(draw, canvas, t, scene) {
    const ctx = canvas.getContext('2d');
    ctx.reset();
    const result = draw(ctx, t, scene);
    if (result !== null && result !== undefined && typeof result.then === 'function') {
      throw new Error('back and front must draw synchronously and return nothing; do not use async or return a Promise.');
    }
    return canvas.transferToImageBitmap();
  }

  listen('message', (event) => {
    const message = event.data;
    if (message === null || typeof message !== 'object' || message.type !== 'frame') return;
    const { id, t, scene } = message;
    const frozen = deepFreeze(structuredClone(scene));
    let back = null;
    let front = null;
    try {
      back = render(mod.back, canvasFor('back', scene), t, frozen);
      if (typeof mod.front === 'function') front = render(mod.front, canvasFor('front', scene), t, frozen);
    } catch (error) {
      if (back) back.close();
      if (front) front.close();
      post({ type: 'frame', id, error: { kind: 'module-error', message: describeError(error) } });
      return;
    }
    post({ type: 'frame', id, back, front }, front ? [back, front] : [back]);
  });
}
