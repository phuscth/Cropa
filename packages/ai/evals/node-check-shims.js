/* eslint-disable @typescript-eslint/no-extraneous-class -- plain JS classes whose fields are set in the constructor */
// Evaluated inside the vm context of the checker, never in the host realm. It defines the browser
// globals the sandbox worker runtime and the model's module expect (a recording OffscreenCanvas,
// a stub WebGLRenderer, postMessage and friends), so every function and class a module can reach
// has the context's own Function as its constructor and no host object is ever handed in.
// The host talks to it only through __cropaDriver, with strings in and strings out.

(() => {
  const round = (value, step = 0.1) => {
    const rounded = Math.round(value / step) * step;
    return rounded === 0 ? 0 : Number(rounded.toFixed(4));
  };

  // Numbers in a colour string are rounded, and an hsl hue wraps, so 360 and 0 compare equal.
  const normString = (text) =>
    text
      .replace(/(hsla?\(\s*)(-?\d+(?:\.\d+)?)(?:deg)?/gi, (_all, head, hue) =>
        `${head}${String(((round(Number(hue)) % 360) + 360) % 360)}`,
      )
      .replace(/-?\d+\.\d+(?:e[+-]?\d+)?/gi, (n) => String(round(Number(n))));

  class RecordedGradient {
    constructor(canvas, id) {
      this.canvas = canvas;
      this.id = id;
    }

    addColorStop(offset, color) {
      this.canvas.ops.push(['addColorStop', this.id, norm(offset), norm(color)]);
    }
  }

  class RecordedPattern {
    constructor(id) {
      this.id = id;
    }
  }

  class RecordedPath {
    constructor(d) {
      this.ops = [];
      if (d !== undefined) this.ops.push(['d', norm(d)]);
    }
  }
  for (const name of [
    'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo', 'ellipse',
    'rect', 'roundRect', 'closePath', 'addPath',
  ]) {
    RecordedPath.prototype[name] = function record(...args) {
      this.ops.push([name, ...args.map(norm)]);
    };
  }

  class StubCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      // What the 2D context drew since the last reset or transfer.
      this.ops = [];
      // What the stub WebGL renderer drew last.
      this.render = null;
      this.gradients = 0;
      this.context = null;
    }

    getContext(kind) {
      if (kind === 'webgl2' || kind === 'webgl') return {};
      if (kind !== '2d') return null;
      this.context ??= recordingContext(this);
      return this.context;
    }

    clear() {
      this.ops = [];
      this.gradients = 0;
    }

    transferToImageBitmap() {
      const bitmap = { width: this.width, height: this.height, ops: this.ops, close: () => undefined };
      this.clear();
      return bitmap;
    }
  }

  // A value as it goes into the op list: rounded numbers, canvases and gradients by content.
  function norm(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? round(value) : String(value);
    if (typeof value === 'string') return normString(value);
    if (value === null || typeof value === 'boolean') return value;
    if (value === undefined) return null;
    if (typeof value === 'function') return 'function';
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, norm);
    if (value instanceof RecordedGradient) return { gradient: value.id };
    if (value instanceof RecordedPattern) return { pattern: value.id };
    if (value instanceof RecordedPath) return { path: value.ops };
    if (value instanceof StubCanvas) return { canvas: { ops: value.ops.slice(), render: value.render } };
    if (typeof value === 'object' && 'ops' in value && 'width' in value && 'height' in value) {
      return { bitmap: [value.width, value.height] };
    }
    return { object: Object.prototype.toString.call(value) };
  }

  const ATTRIBUTE_DEFAULTS = new Map([
    ['globalAlpha', 1], ['globalCompositeOperation', 'source-over'], ['fillStyle', '#000000'],
    ['strokeStyle', '#000000'], ['lineWidth', 1], ['lineCap', 'butt'], ['lineJoin', 'miter'],
    ['miterLimit', 10], ['lineDashOffset', 0], ['font', '10px sans-serif'], ['textAlign', 'start'],
    ['textBaseline', 'alphabetic'], ['direction', 'ltr'], ['letterSpacing', '0px'],
    ['wordSpacing', '0px'], ['fontKerning', 'auto'], ['fontStretch', 'normal'],
    ['fontVariantCaps', 'normal'], ['textRendering', 'auto'], ['shadowBlur', 0],
    ['shadowOffsetX', 0], ['shadowOffsetY', 0], ['shadowColor', 'rgba(0, 0, 0, 0)'],
    ['filter', 'none'], ['imageSmoothingEnabled', true], ['imageSmoothingQuality', 'low'],
  ]);

  const fontSize = (font) => {
    const match = typeof font === 'string' ? /(\d+(?:\.\d+)?)px/.exec(font) : null;
    return match?.[1] === undefined ? 10 : Number(match[1]);
  };

  // A 2D context that does not draw: every call and property set goes into canvas.ops.
  function recordingContext(canvas) {
    const state = new Map();
    const record = (...op) => {
      canvas.ops.push(op.map(norm));
    };
    const gradient = (name, args) => {
      const id = canvas.gradients++;
      record(name, id, ...args);
      return new RecordedGradient(canvas, id);
    };
    const blank = (width, height) => {
      const w = Math.max(0, Math.floor(Number(width)) || 0);
      const h = Math.max(0, Math.floor(Number(height)) || 0);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    };
    const methods = {
      reset: () => {
        canvas.clear();
        state.clear();
      },
      createLinearGradient: (...args) => gradient('createLinearGradient', args),
      createRadialGradient: (...args) => gradient('createRadialGradient', args),
      createConicGradient: (...args) => gradient('createConicGradient', args),
      createPattern: (...args) => {
        const id = canvas.gradients++;
        record('createPattern', id, args[1]);
        return new RecordedPattern(id);
      },
      measureText: (text) => {
        const size = fontSize(state.get('font'));
        const width = String(text).length * size * 0.6;
        return {
          width,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: width,
          actualBoundingBoxAscent: size * 0.8,
          actualBoundingBoxDescent: size * 0.2,
          fontBoundingBoxAscent: size * 0.9,
          fontBoundingBoxDescent: size * 0.25,
        };
      },
      getImageData: (...args) => blank(args[2], args[3]),
      createImageData: (...args) => blank(args[0], args[1]),
      getLineDash: () => state.get('lineDash') ?? [],
      setLineDash: (segments) => {
        state.set('lineDash', segments);
        record('setLineDash', segments);
      },
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      isPointInPath: () => false,
      isPointInStroke: () => false,
    };
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'canvas') return canvas;
          if (Object.hasOwn(methods, prop)) return methods[prop];
          if (ATTRIBUTE_DEFAULTS.has(prop)) {
            return state.has(prop) ? state.get(prop) : ATTRIBUTE_DEFAULTS.get(prop);
          }
          return (...args) => {
            record(prop, ...args);
          };
        },
        set(_target, prop, value) {
          if (typeof prop === 'symbol') return true;
          state.set(prop, value);
          record(`=${prop}`, value);
          return true;
        },
      },
    );
  }

  // ------------------------------------------------------------------------------ three.js

  const matrixOf = (matrix) =>
    matrix === undefined ? null : Array.from(matrix.elements, (v) => round(v, 0.01));

  // Enough of an array to notice that it moved, without listing every value.
  const checksum = (values) => {
    if (values === undefined) return null;
    let sum = 0;
    let weighted = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i] ?? 0;
      sum += v;
      weighted += v * ((i % 7) + 1);
    }
    return [values.length, round(sum, 0.01), round(weighted, 0.01)];
  };

  const materialOf = (material) => {
    if (Array.isArray(material)) return material.map(materialOf);
    return [material?.color?.getHexString() ?? null, round(material?.opacity ?? 1, 0.01)];
  };

  const NOOP = new Proxy(function noop() {}, {
    get: (_target, prop) => (typeof prop === 'symbol' || prop === 'then' ? undefined : NOOP),
    apply: () => undefined,
  });

  // Takes any option, call or property set; render records what it would draw into its canvas.
  class StubRenderer {
    constructor(params) {
      this.domElement = params?.canvas instanceof StubCanvas ? params.canvas : new StubCanvas(300, 150);
      return new Proxy(this, {
        get: (target, prop) => (prop in target ? Reflect.get(target, prop, target) : NOOP),
      });
    }

    setSize(width, height) {
      this.domElement.width = width;
      this.domElement.height = height;
    }

    render(scene, camera) {
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      const ops = [['camera', matrixOf(camera.matrixWorld), matrixOf(camera.projectionMatrix)]];
      scene.traverseVisible((object) => {
        if (object.isMesh || object.isPoints || object.isLine || object.isSprite) {
          ops.push([
            'object',
            matrixOf(object.matrixWorld),
            materialOf(object.material),
            object.isPoints ? checksum(object.geometry?.attributes?.position?.array) : null,
            checksum(object.instanceMatrix?.array),
          ]);
        } else if (object.isLight) {
          ops.push(['light', matrixOf(object.matrixWorld), object.color?.getHexString() ?? null, round(object.intensity ?? 1, 0.01)]);
        }
      });
      this.domElement.render = ops;
    }
  }

  // ---------------------------------------------------------------------------- worker globals

  const inbox = [];
  const listeners = [];
  // A counter, not a clock: modules must not depend on time while drawing.
  let ticks = 0;
  const g = globalThis;
  g.postMessage = (message) => {
    inbox.push(message);
  };
  g.addEventListener = (_type, listener) => {
    listeners.push(listener);
  };
  g.OffscreenCanvas = StubCanvas;
  g.Path2D = RecordedPath;
  g.structuredClone = (value) => JSON.parse(JSON.stringify(value));
  g.performance = { now: () => ticks++ };
  g.console = { log() {}, info() {}, warn() {}, error() {} };
  g.setTimeout = () => 0;
  g.clearTimeout = () => undefined;
  g.setInterval = () => 0;
  g.clearInterval = () => undefined;
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => undefined;
  g.Worker = () => undefined;
  g.SharedWorker = () => undefined;

  const message = (error) =>
    String(error !== null && typeof error === 'object' && 'message' in error ? error.message : error);

  Object.defineProperty(g, '__cropaDriver', {
    value: {
    // The first `loaded` message the worker posted, as JSON.
    loaded() {
      return JSON.stringify(inbox.find((m) => m && m.type === 'loaded') ?? null);
    },
    // Delivers one frame request and returns the worker's reply as JSON.
    frame(id, t, sceneJson) {
      inbox.length = 0;
      try {
        const scene = JSON.parse(sceneJson);
        for (const listener of listeners.slice()) listener({ data: { type: 'frame', id, t, scene } });
      } catch (error) {
        return JSON.stringify({ threw: message(error) });
      }
      return JSON.stringify(inbox.find((m) => m && m.type === 'frame' && m.id === id) ?? null);
    },
    // Puts three.js, with the stub renderer, on the global.
    useThree(namespace) {
      g.THREE = Object.assign({}, namespace, { WebGLRenderer: StubRenderer });
    },
    },
  });
})();
