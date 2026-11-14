export interface BackgroundExample {
  name: string;
  source: string;
  durationMs: number;
  threeD: boolean;
}

const PRNG = `function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}`;

const COLOR = `// Colour helpers: '#rrggbb' -> [r, g, b], mixing, and an rgba() string.
const rgb = (hex) => {
  const n = parseInt(hex.slice(1, 7), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const css = (c, a = 1) => 'rgba(' + c.map(Math.round).join(',') + ',' + a + ')';
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** A dark base, a mid tone, a light and the most saturated colour as the accent. */
function tones(palette) {
  const all = (palette.length > 0 ? palette : ['#0b1026', '#3b4a7a', '#f2c94c']).map(rgb);
  const byLuma = [...all].sort((a, b) => luma(a) - luma(b));
  const chroma = (c) => Math.max(...c) - Math.min(...c);
  const accent = [...all].sort((a, b) => chroma(b) - chroma(a))[0];
  return {
    base: mix(byLuma[0], [3, 4, 12], 0.55),
    mid: byLuma[Math.floor(byLuma.length / 2)],
    light: mix(byLuma[byLuma.length - 1], [255, 255, 255], 0.25),
    accent,
  };
}`;

const GRAIN = `/** A seeded 256 px noise tile, built once; it is filled as a pattern every frame. */
function grainTile() {
  const size = 256;
  const tile = new OffscreenCanvas(size, size);
  const g = tile.getContext('2d');
  const image = g.createImageData(size, size);
  const noise = mulberry32(3);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 64 + noise() * 128;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  g.putImageData(image, 0, 0);
  return tile;
}

function finish(ctx, w, h, grain, strength) {
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = strength;
  ctx.fillStyle = ctx.createPattern(grain, 'repeat');
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.4, w / 2, h / 2, Math.hypot(w, h) / 2);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}`;

/**
 * Complete, valid modules. They are shown to the model as worked examples, and the tests and
 * the mock eval run them, so each one must load, stay periodic and draw within the time limit.
 */
export const BACKGROUND_EXAMPLES: readonly BackgroundExample[] = [
  {
    name: 'Aurora over a night sky, with grain',
    durationMs: 10000,
    threeD: false,
    source: `const meta = { durationMs: 10000 };

${PRNG}

${COLOR}

${GRAIN}

const TAU = Math.PI * 2;
const rand = mulberry32(11);
// Large soft lights drifting on closed paths: whole cycles of t.
const glows = Array.from({ length: 5 }, (_, i) => ({
  x: 0.1 + rand() * 0.8,
  y: 0.2 + rand() * 0.6,
  r: 0.35 + rand() * 0.3,
  ax: 0.05 + rand() * 0.06,
  ay: 0.03 + rand() * 0.04,
  k: 1 + (i % 2),
  phase: rand() * TAU,
  tone: i % 3,
}));
// Aurora curtains: wavy bands, each wave moving a whole number of cycles per loop.
const bands = Array.from({ length: 3 }, (_, i) => ({
  y: 0.3 + i * 0.12,
  amp: 0.04 + rand() * 0.03,
  waves: 1 + i,
  k: i === 1 ? -1 : 1,
  height: 0.18 + rand() * 0.1,
  phase: rand() * TAU,
}));
const stars = Array.from({ length: 60 }, () => ({
  x: rand(),
  y: rand() * 0.55,
  size: 0.6 + rand() * rand() * 2.2,
  k: 1 + Math.floor(rand() * 3),
  phase: rand() * TAU,
}));

let field = null;
let grain = null;

function back(ctx, t, scene) {
  const { width: w, height: h, frame } = scene;
  const c = tones(scene.palette);

  // Soft layers are painted at 1/8 size and scaled up: a smooth blur for free.
  const fw = Math.max(16, Math.round(w / 8));
  const fh = Math.max(16, Math.round(h / 8));
  if (field === null || field.width !== fw || field.height !== fh) field = new OffscreenCanvas(fw, fh);
  const f = field.getContext('2d');
  f.reset();
  const sky = f.createLinearGradient(0, 0, 0, fh);
  sky.addColorStop(0, css(mix(c.base, [0, 0, 0], 0.3)));
  sky.addColorStop(0.55, css(c.base));
  sky.addColorStop(1, css(mix(c.base, c.mid, 0.35)));
  f.fillStyle = sky;
  f.fillRect(0, 0, fw, fh);
  f.globalCompositeOperation = 'lighter';
  for (const g of glows) {
    const x = (g.x + g.ax * Math.sin(TAU * g.k * t + g.phase)) * fw;
    const y = (g.y + g.ay * Math.cos(TAU * t + g.phase)) * fh;
    const r = g.r * Math.max(fw, fh);
    const tint = [c.mid, c.accent, c.light][g.tone];
    const glow = f.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, css(tint, 0.22));
    glow.addColorStop(0.5, css(tint, 0.08));
    glow.addColorStop(1, css(tint, 0));
    f.fillStyle = glow;
    f.fillRect(0, 0, fw, fh);
  }
  for (const b of bands) {
    const wave = (u, lift, shift) =>
      (b.y - lift + b.amp * Math.sin(TAU * (b.waves * u + b.k * t) + b.phase + shift)) * fh;
    f.beginPath();
    for (let i = 0; i <= 40; i++) f.lineTo((i / 40) * fw, wave(i / 40, 0, 0));
    for (let i = 40; i >= 0; i--) f.lineTo((i / 40) * fw, wave(i / 40, b.height, 0.9));
    f.closePath();
    const curtain = f.createLinearGradient(0, (b.y + b.amp) * fh, 0, (b.y - b.height - b.amp) * fh);
    curtain.addColorStop(0, css(c.accent, 0));
    curtain.addColorStop(0.12, css(mix(c.accent, c.light, 0.35), 0.5));
    curtain.addColorStop(0.5, css(c.accent, 0.18));
    curtain.addColorStop(1, css(c.accent, 0));
    f.fillStyle = curtain;
    f.fill();
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(field, 0, 0, w, h);

  // A key light behind the screenshot, so the card reads as lit.
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height * 0.3;
  const key = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(frame.width, frame.height) * 0.8);
  key.addColorStop(0, css(c.light, 0.16 + 0.04 * Math.sin(TAU * t)));
  key.addColorStop(0.6, css(c.light, 0.04));
  key.addColorStop(1, css(c.light, 0));
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, w, h);

  // Sparse stars of varied size, twinkling at their own pace.
  ctx.globalCompositeOperation = 'lighter';
  const unit = Math.min(w, h) / 1080;
  for (const s of stars) {
    ctx.fillStyle = css(c.light, 0.15 + 0.4 * (0.5 + 0.5 * Math.sin(TAU * s.k * t + s.phase)));
    ctx.beginPath();
    ctx.arc(s.x * w, s.y * h, s.size * unit, 0, TAU);
    ctx.fill();
  }

  grain ??= grainTile();
  finish(ctx, w, h, grain, 0.1);
}
`,
  },
  {
    name: 'Bokeh in three depth layers',
    durationMs: 12000,
    threeD: false,
    source: `const meta = { durationMs: 12000 };

${PRNG}

${COLOR}

${GRAIN}

const TAU = Math.PI * 2;
const rand = mulberry32(5);
// Depth 0 is far (small, dim, slow), 1 is near (large, soft, moves more).
const discs = Array.from({ length: 46 }, (_, i) => {
  const depth = i < 30 ? rand() * 0.4 : i < 42 ? 0.4 + rand() * 0.35 : 0.8 + rand() * 0.2;
  return {
    x: rand(),
    y: rand(),
    depth,
    size: 0.012 + depth * depth * 0.11 + rand() * 0.01,
    drift: 0.006 + depth * 0.03,
    kx: 1,
    ky: 1 + Math.floor(rand() * 2),
    phase: rand() * TAU,
    tone: Math.floor(rand() * 3),
  };
});

let grain = null;

/** One out-of-focus disc: a soft body with a slightly brighter rim. */
function disc(ctx, x, y, r, color, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, css(color, alpha * 0.55));
  g.addColorStop(0.72, css(color, alpha * 0.65));
  g.addColorStop(0.88, css(color, alpha));
  g.addColorStop(1, css(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

function drawDiscs(ctx, t, scene, from, to, fade) {
  const { width: w, height: h } = scene;
  const c = tones(scene.palette);
  const unit = Math.max(w, h);
  ctx.globalCompositeOperation = 'lighter';
  for (const d of discs) {
    if (d.depth < from || d.depth >= to) continue;
    const x = (d.x + d.drift * Math.sin(TAU * d.kx * t + d.phase)) * w;
    const y = (d.y + d.drift * Math.cos(TAU * d.ky * t + d.phase)) * h;
    const breathe = 0.85 + 0.15 * Math.sin(TAU * t + d.phase * 2);
    // Far discs are tinted toward the base: atmospheric perspective.
    const color = mix([c.accent, c.light, c.mid][d.tone], c.base, 0.55 - d.depth * 0.5);
    disc(ctx, x, y, d.size * unit, color, (0.1 + d.depth * 0.14) * breathe * fade);
  }
  ctx.globalCompositeOperation = 'source-over';
}

function back(ctx, t, scene) {
  const { width: w, height: h, frame } = scene;
  const c = tones(scene.palette);
  const base = ctx.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, css(mix(c.base, c.mid, 0.35)));
  base.addColorStop(0.55, css(c.base));
  base.addColorStop(1, css(mix(c.base, [0, 0, 0], 0.4)));
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // A wide glow from behind the screenshot.
  const cx = frame.x + frame.width * 0.5;
  const cy = frame.y + frame.height * 0.45;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(w, h) * 0.5);
  glow.addColorStop(0, css(c.accent, 0.28));
  glow.addColorStop(0.45, css(c.accent, 0.08));
  glow.addColorStop(1, css(c.accent, 0));
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  drawDiscs(ctx, t, scene, 0, 0.8, 1);
  grain ??= grainTile();
  finish(ctx, w, h, grain, 0.08);
}

// The nearest discs pass in front of the screenshot, faint enough to keep it readable.
function front(ctx, t, scene) {
  drawDiscs(ctx, t, scene, 0.8, 1.01, 0.3);
}
`,
  },
  {
    name: 'Dust in shafts of light',
    durationMs: 9000,
    threeD: false,
    source: `const meta = { durationMs: 9000 };

${PRNG}

${COLOR}

${GRAIN}

const TAU = Math.PI * 2;
const rand = mulberry32(42);
// Shafts fan out from a source above the top-left corner.
const shafts = Array.from({ length: 4 }, (_, i) => ({
  angle: 0.42 + i * 0.16 + rand() * 0.05,
  spread: 0.035 + rand() * 0.035,
  strength: 0.5 + rand() * 0.5,
  phase: rand() * TAU,
}));
// Motes at different depths: size, brightness and drift grow with depth.
const motes = Array.from({ length: 150 }, () => {
  const depth = rand() ** 1.6;
  return {
    x: rand(),
    y: rand(),
    depth,
    orbit: 0.004 + depth * 0.02,
    k: 1 + Math.floor(rand() * 2),
    phase: rand() * TAU,
  };
});

let haze = null;
let grain = null;

function back(ctx, t, scene) {
  const { width: w, height: h } = scene;
  const c = tones(scene.palette);
  const warm = mix(c.light, [255, 214, 160], 0.35);
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, css(mix(c.base, c.mid, 0.25)));
  base.addColorStop(1, css(mix(c.base, [0, 0, 0], 0.45)));
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // The shafts are painted small and scaled up so their edges are soft.
  const sx = -0.08 * w;
  const sy = -0.2 * h;
  const fw = Math.max(16, Math.round(w / 6));
  const fh = Math.max(16, Math.round(h / 6));
  if (haze === null || haze.width !== fw || haze.height !== fh) haze = new OffscreenCanvas(fw, fh);
  const f = haze.getContext('2d');
  f.reset();
  f.scale(fw / w, fh / h);
  f.globalCompositeOperation = 'lighter';
  const reach = Math.hypot(w, h) * 1.3;
  for (const s of shafts) {
    const a = s.strength * (0.75 + 0.25 * Math.sin(TAU * t + s.phase));
    const beam = f.createLinearGradient(sx, sy, sx + Math.cos(s.angle) * reach, sy + Math.sin(s.angle) * reach);
    beam.addColorStop(0, css(warm, 0.5 * a));
    beam.addColorStop(0.6, css(warm, 0.14 * a));
    beam.addColorStop(1, css(warm, 0));
    f.fillStyle = beam;
    f.beginPath();
    f.moveTo(sx, sy);
    f.lineTo(sx + Math.cos(s.angle - s.spread) * reach, sy + Math.sin(s.angle - s.spread) * reach);
    f.lineTo(sx + Math.cos(s.angle + s.spread) * reach, sy + Math.sin(s.angle + s.spread) * reach);
    f.closePath();
    f.fill();
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(haze, 0, 0, w, h);
  // The light source itself, just off the top-left corner.
  const source = ctx.createRadialGradient(0.04 * w, 0, 0, 0.04 * w, 0, Math.max(w, h) * 0.55);
  source.addColorStop(0, css(warm, 0.32));
  source.addColorStop(0.4, css(warm, 0.1));
  source.addColorStop(1, css(warm, 0));
  ctx.fillStyle = source;
  ctx.fillRect(0, 0, w, h);

  // Motes only catch the light inside a shaft, so the field is uneven, like real dust.
  ctx.globalCompositeOperation = 'lighter';
  const unit = Math.min(w, h) / 1080;
  for (const m of motes) {
    const x = (m.x + m.orbit * Math.sin(TAU * m.k * t + m.phase)) * w;
    const y = (m.y + m.orbit * Math.cos(TAU * t + m.phase)) * h;
    const angle = Math.atan2(y - sy, x - sx);
    let lit = 0.12;
    for (const s of shafts) lit += Math.max(0, 1 - Math.abs(angle - s.angle) / (s.spread * 2)) * s.strength;
    const alpha = Math.min(1, lit) * (0.5 + 0.5 * m.depth) * (0.6 + 0.4 * Math.sin(TAU * m.k * t + m.phase * 3));
    if (alpha < 0.03) continue;
    const r = (1.2 + m.depth * m.depth * 6) * unit;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 2.5);
    glow.addColorStop(0, css(warm, alpha));
    glow.addColorStop(0.3, css(warm, alpha * 0.45));
    glow.addColorStop(1, css(warm, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(x - r * 2.5, y - r * 2.5, r * 5, r * 5);
  }

  grain ??= grainTile();
  finish(ctx, w, h, grain, 0.1);
}
`,
  },
  {
    name: 'Studio objects with physical materials (three.js)',
    durationMs: 10000,
    threeD: true,
    source: `const meta = { durationMs: 10000 };

${COLOR}

const TAU = Math.PI * 2;
const color3 = (c) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
let renderer = null;
let world = null;
let camera = null;
let objects = [];

function setup(scene) {
  const c = tones(scene.palette);
  renderer = new THREE.WebGLRenderer({
    canvas: new OffscreenCanvas(scene.width, scene.height),
    alpha: true,
    antialias: true,
  });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  world = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, scene.width / scene.height, 0.1, 100);
  camera.position.set(0, 0, 12);
  // project() below needs the camera's matrices before the first render.
  camera.updateMatrixWorld();

  // Reflections come from a soft room environment, the shape from one key light.
  const pmrem = new THREE.PMREMGenerator(renderer);
  world.environment = pmrem.fromScene(new THREE.addons.RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-4, 6, 8);
  world.add(key);

  const glossy = new THREE.MeshPhysicalMaterial({
    color: color3(c.accent),
    roughness: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
  });
  const satin = new THREE.MeshPhysicalMaterial({
    color: color3(mix(c.light, c.mid, 0.3)),
    roughness: 0.6,
    sheen: 1,
    sheenColor: color3(c.light),
  });
  const metal = new THREE.MeshPhysicalMaterial({
    color: color3(mix(c.light, [255, 255, 255], 0.4)),
    metalness: 1,
    roughness: 0.25,
  });
  const pearl = new THREE.MeshPhysicalMaterial({
    color: color3(mix(c.light, [255, 255, 255], 0.5)),
    roughness: 0.18,
    iridescence: 1,
    iridescenceIOR: 1.3,
  });
  objects = [
    { mesh: new THREE.Mesh(new THREE.addons.RoundedBoxGeometry(1.6, 1.6, 1.6, 6, 0.3), glossy), corner: [0, 0], size: 1 },
    { mesh: new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.28, 48, 128), metal), corner: [1, 0], size: 0.9 },
    { mesh: new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.1, 16, 48), satin), corner: [1, 1], size: 1 },
    { mesh: new THREE.Mesh(new THREE.SphereGeometry(0.85, 64, 32), pearl), corner: [0, 1], size: 0.9 },
  ];
  for (const o of objects) world.add(o.mesh);
}

function back(ctx, t, scene) {
  const { width: w, height: h, frame } = scene;
  const c = tones(scene.palette);
  if (renderer === null) setup(scene);
  // The canvas size follows the scene: a preview and a 4K export use the same module.
  if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // A light studio backdrop: brightest behind the screenshot, falling off to the corners.
  const backdrop = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.hypot(w, h) * 0.6);
  backdrop.addColorStop(0, css(mix(c.light, [255, 255, 255], 0.5)));
  backdrop.addColorStop(0.55, css(mix(c.light, c.mid, 0.35)));
  backdrop.addColorStop(1, css(mix(c.mid, c.base, 0.45)));
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, w, h);

  // Each object sits on a corner of the frame, partly tucked behind it but inside the canvas,
  // floating and turning. Placed in pixels, then converted to world units in the plane z = 0.
  const unit = (2 * 12 * Math.tan((17.5 * Math.PI) / 180)) / h;
  const spin = 2 * Math.PI * t;
  objects.forEach((o, i) => {
    const radius = Math.min(w, h) * 0.11 * o.size;
    const clamp = (v, max) => Math.min(max - radius * 1.05, Math.max(radius * 1.05, v));
    const lift = 0.06 * radius * Math.sin(TAU * t + i * 1.7);
    const px = clamp(frame.x + o.corner[0] * frame.width + (o.corner[0] ? 0.15 : -0.15) * radius, w);
    const py = clamp(frame.y + o.corner[1] * frame.height + (o.corner[1] ? 0.15 : -0.15) * radius, h) + lift;
    o.mesh.position.set((px - w / 2) * unit, (h / 2 - py) * unit, 0);
    o.mesh.scale.setScalar((radius * unit) / 0.85);
    o.mesh.rotation.set(0.5 + 0.2 * Math.sin(TAU * t + i), spin * (i % 2 ? -1 : 1) + i, 0.3 * Math.cos(TAU * t + i));
    // A soft contact shadow on the backdrop, below and behind the object.
    const sx = px + radius * 0.15;
    const sy = py + radius * 1.05;
    const r = radius * (1.1 + lift / radius);
    const shadow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    shadow.addColorStop(0, css(mix(c.base, [0, 0, 0], 0.5), 0.3));
    shadow.addColorStop(1, css(c.base, 0));
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(sx, sy, r, r * 0.35, 0, 0, TAU);
    ctx.fill();
  });

  renderer.render(world, camera);
  ctx.drawImage(renderer.domElement, 0, 0);
}
`,
  },
  {
    name: 'Glowing orbits with bloom (three.js)',
    durationMs: 8000,
    threeD: true,
    source: `const meta = { durationMs: 8000 };

${COLOR}

const TAU = Math.PI * 2;
const color3 = (c) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
let renderer = null;
let world = null;
let camera = null;
let composer = null;
let core = null;
const orbits = [];

/** An opaque gradient backdrop painted into a texture: bloom does not keep transparency. */
function backdropTexture(c) {
  const canvas = new OffscreenCanvas(256, 256);
  const g = canvas.getContext('2d');
  const fill = g.createRadialGradient(128, 120, 0, 128, 128, 180);
  fill.addColorStop(0, css(mix(c.base, c.accent, 0.2)));
  fill.addColorStop(0.55, css(c.base));
  fill.addColorStop(1, css(mix(c.base, [0, 0, 0], 0.6)));
  g.fillStyle = fill;
  g.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function setup(scene) {
  const c = tones(scene.palette);
  const { width: w, height: h } = scene;
  renderer = new THREE.WebGLRenderer({ canvas: new OffscreenCanvas(w, h), antialias: true });
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  world = new THREE.Scene();
  world.background = backdropTexture(c);
  camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
  camera.position.set(0, 0, 10);

  // A bright core hidden behind the screenshot: bloom spills its light round the card.
  core = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 24),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color3(mix(c.light, c.accent, 0.35)), emissiveIntensity: 2.2 }),
  );
  world.add(core);
  // Thin tilted orbits that pass behind the card and swing out into the margins.
  for (let i = 0; i < 6; i++) {
    const material = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color3(mix(c.accent, c.light, (i % 3) * 0.3)) });
    const arc = TAU * (0.55 + 0.12 * (i % 3));
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.005 + 0.003 * (i % 2), 12, 256, arc), material);
    world.add(mesh);
    orbits.push({ mesh, material, size: 1.1 + i * 0.09, tilt: 1.2 + 0.08 * Math.sin(i * 2.1), yaw: 0.2 * Math.cos(i * 1.3), turn: i % 2 ? -1 : 1, phase: i * 1.1 });
  }

  const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
  composer = new THREE.addons.EffectComposer(renderer, target);
  composer.addPass(new THREE.addons.RenderPass(world, camera));
  composer.addPass(new THREE.addons.UnrealBloomPass(new THREE.Vector2(w, h), 0.85, 0.6, 0.2));
  composer.addPass(new THREE.addons.OutputPass());
}

function back(ctx, t, scene) {
  const { width: w, height: h, frame } = scene;
  if (renderer === null) setup(scene);
  if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  // World units per pixel in the plane z = 0, to place things relative to the frame.
  const unit = (2 * 10 * Math.tan((20 * Math.PI) / 180)) / h;
  const fx = (frame.x + frame.width / 2 - w / 2) * unit;
  const fy = (h / 2 - frame.y - frame.height / 2) * unit;
  core.position.set(fx, fy, -2);
  core.scale.setScalar(frame.height * unit * 0.42 * (1 + 0.04 * Math.sin(TAU * t)));
  for (const o of orbits) {
    o.mesh.position.set(fx, fy, 0);
    o.mesh.scale.setScalar((frame.width / 2) * unit * o.size);
    // Spin in the orbit's own plane, then tilt: the gap in each arc travels round.
    o.mesh.rotation.set(o.tilt, o.yaw, o.turn * TAU * t + o.phase);
    // A pulse of light runs across the orbits once per loop.
    o.material.emissiveIntensity = 0.4 + 1.6 * Math.max(0, Math.cos(TAU * t - o.phase));
  }
  composer.render();
  ctx.drawImage(renderer.domElement, 0, 0);
}
`,
  },
];
