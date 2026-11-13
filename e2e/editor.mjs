// End-to-end smoke test of the editor: the app opens a fixture image in the
// editor and the preview canvas shows it unmirrored; picking a built-in
// background preset changes the preview; Ctrl+S saves a PNG of the export size
// with that background. Drives the app through tauri-driver (WebDriver) and
// msedgedriver. Run with `pnpm e2e:editor` after `pnpm e2e:build`.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { ensureMsedgedriver } from './msedgedriver.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = process.env.CROPA_E2E_APP ?? path.join(root, 'target', 'e2e-app', 'debug', 'cropa-desktop.exe');
const fixture = path.join(root, 'e2e', 'fixtures', 'two-colours.png');
const DRIVER = 'http://127.0.0.1:4444';

const MAGENTA = [255, 0, 255];
const CYAN = [0, 200, 255];

/** A failure that `waitFor` retries until its deadline. Defined before any use: classes are not hoisted. */
class PollError extends Error {
  constructor(cause) {
    super(String(cause?.message ?? cause));
  }
}

// The same renderer code the editor uses, for the expected export size and the
// preset's colours.
const core = await import(pathToFileURL(path.join(root, 'packages', 'core', 'src', 'index.ts')).href);

// A built-in preset with one plain gradient whose colours are far from the
// default background's, so a single pixel tells the two apart.
const PRESET = 'slate';
const presetLayers = core.builtinPresets.find((preset) => preset.id === PRESET)?.background.layers;
assert.ok(
  presetLayers?.length === 1 && presetLayers[0].type === 'linear',
  `the "${PRESET}" preset is no longer one linear gradient; pick another plain one for this test`,
);
const stops = presetLayers[0].stops.map((stop) => hexColour(stop.color));
const TOLERANCE = 6;
/** True when `rgb` lies between the gradient's stops, channel by channel. */
const isPresetColour = (rgb) =>
  [0, 1, 2].every(
    (c) =>
      rgb[c] >= Math.min(...stops.map((s) => s[c])) - TOLERANCE &&
      rgb[c] <= Math.max(...stops.map((s) => s[c])) + TOLERANCE,
  );

// The editor starts from the default scene of the image; a background preset
// does not change the size.
const fixturePng = decodePng(fs.readFileSync(fixture));
const scene = core.defaultScene({ width: fixturePng.width, height: fixturePng.height });
const baseSize = core.outputSize(scene, 1);
const exportSize = core.outputSize(scene, 2);
// Where to sample the background, as a fraction of the height: a quarter of the
// way into the top padding, clear of the image and its shadow.
const BAND_Y = scene.frame.padding / 4 / baseSize.height;

const dir = path.join(os.tmpdir(), `cropa-e2e-editor-${process.pid}`);
const saveFolder = path.join(dir, 'saved');
let driver;
let driverOutput = '';
let sessionId;

try {
  if (!fs.existsSync(app)) throw new Error(`${app} is missing; run \`pnpm e2e:build\` first.`);
  const msedgedriver = await ensureMsedgedriver();

  // A capture key the user's own Cropa does not hold, so the shortcut-error notice
  // does not appear (the window ends on the editor either way, because the test
  // image opens after the startup Settings request); a save folder, so Ctrl+S
  // never opens a folder dialog.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(saveFolder);
  fs.writeFileSync(
    path.join(dir, 'config', 'settings.json'),
    JSON.stringify({
      version: 4,
      captureShortcut: 'Ctrl+Alt+Shift+F9',
      autostartAsked: true,
      saveFolder,
    }),
  );

  // msedgedriver starts the app as its child, so the app inherits this environment.
  driver = spawn(
    process.env.TAURI_DRIVER ?? 'tauri-driver',
    ['--port', '4444', '--native-port', '4445', '--native-driver', msedgedriver],
    {
      env: { ...process.env, CROPA_E2E_DIR: dir, CROPA_E2E_EDITOR_IMAGE: fixture },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const collect = (chunk) => (driverOutput += chunk);
  driver.stdout.on('data', collect);
  driver.stderr.on('data', collect);
  let spawnError;
  driver.on('error', (error) => (spawnError = error));

  await waitFor('tauri-driver to answer', 20_000, async () => {
    if (spawnError) {
      throw new Error(
        `Could not start tauri-driver (${spawnError.message}); install it with \`cargo install tauri-driver --version 2.0.6 --locked\`.`,
      );
    }
    try {
      return (await fetch(`${DRIVER}/status`)).ok;
    } catch {
      return false;
    }
  });

  const created = await webdriver('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: app } } },
  }, 120_000);
  sessionId = created.value?.sessionId ?? created.sessionId;
  assert.ok(sessionId, `no WebDriver session id in ${JSON.stringify(created)}`);

  const colours = await waitFor('the editor to show the fixture image', 30_000, async () => {
    // The page may still be navigating, which fails the script; keep polling.
    let result;
    try {
      result = await executeScript(`
      const canvas = document.querySelector('[data-testid="editor-preview"]');
      if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
      const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const count = (want) => {
        let n = 0, sumX = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] === 255 && Math.abs(data[i] - want[0]) <= 3 &&
                Math.abs(data[i + 1] - want[1]) <= 3 && Math.abs(data[i + 2] - want[2]) <= 3) {
              n++;
              sumX += x;
            }
          }
        }
        return { count: n, meanX: n ? sumX / n : 0 };
      };
      return { magenta: count(${JSON.stringify(MAGENTA)}), cyan: count(${JSON.stringify(CYAN)}) };
    `);
    } catch (error) {
      throw new PollError(error);
    }
    return result && result.magenta.count > 500 && result.cyan.count > 500 ? result : null;
  });
  assert.ok(
    colours.magenta.meanX < colours.cyan.meanX,
    `the image is mirrored: magenta at x=${colours.magenta.meanX}, cyan at x=${colours.cyan.meanX}`,
  );
  console.log('editor shows the fixture image: ok');

  const before = await samplePreview();
  assert.ok(!isPresetColour(before), `the default background already looks like "${PRESET}": ${before}`);
  // The presets are in a dropdown: open it from the selector card, then pick the card.
  const picker = await findElement('[data-testid="preset-picker"]');
  await webdriver('POST', `/session/${sessionId}/element/${picker}/click`, {});
  const tile = await waitFor(`the "${PRESET}" card to appear`, 10_000, async () => {
    try {
      return await findElement(`[data-testid="preset-${PRESET}"]`);
    } catch (error) {
      throw new PollError(error);
    }
  });
  await webdriver('POST', `/session/${sessionId}/element/${tile}/click`, {});
  const after = await waitFor(`the preview to show the "${PRESET}" background`, 10_000, async () => {
    let rgb;
    try {
      rgb = await samplePreview();
    } catch (error) {
      throw new PollError(error);
    }
    return isPresetColour(rgb) ? rgb : null;
  });
  // Picking a card closes the dropdown; the selector card then names the preset.
  await waitFor(`the selector card to show "${PRESET}"`, 10_000, async () => {
    try {
      const attribute = await webdriver('GET', `/session/${sessionId}/element/${picker}/attribute/data-current-preset`);
      return attribute.value === PRESET;
    } catch (error) {
      throw new PollError(error);
    }
  });
  console.log(`preset changes the preview (${before} -> ${after}): ok`);

  // Closing the dropdown returned the focus to the selector card, which is inside the
  // window, so the keys reach the editor's window-level shortcut handler.
  await webdriver('POST', `/session/${sessionId}/actions`, {
    actions: [
      {
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value: '' },
          { type: 'keyDown', value: 's' },
          { type: 'keyUp', value: 's' },
          { type: 'keyUp', value: '' },
        ],
      },
    ],
  });
  await webdriver('DELETE', `/session/${sessionId}/actions`);

  // The file is written in place, so a read can catch it half written.
  const saved = await waitFor('Ctrl+S to save a PNG', 20_000, async () => {
    const names = fs.readdirSync(saveFolder).filter((name) => name.toLowerCase().endsWith('.png'));
    if (names.length === 0) return null;
    assert.equal(names.length, 1, `Ctrl+S saved more than one file: ${names.join(', ')}`);
    try {
      return { name: names[0], png: decodePng(fs.readFileSync(path.join(saveFolder, names[0]))) };
    } catch {
      return null;
    }
  });
  assert.deepEqual(
    { width: saved.png.width, height: saved.png.height },
    exportSize,
    `${saved.name} is not the 2x export size`,
  );
  const background = saved.png.pixel(Math.floor(saved.png.width / 2), Math.floor(saved.png.height * BAND_Y));
  assert.ok(
    isPresetColour(background),
    `${saved.name} does not have the "${PRESET}" background: ${background.slice(0, 3)}`,
  );
  console.log(`Ctrl+S saves ${saved.name}, ${saved.png.width}×${saved.png.height}: ok`);
} catch (error) {
  console.error(error);
  console.error('--- tauri-driver output ---');
  console.error(driverOutput);
  const logs = path.join(dir, 'logs');
  if (fs.existsSync(logs)) {
    for (const name of fs.readdirSync(logs)) {
      console.error(`--- ${name} ---`);
      console.error(fs.readFileSync(path.join(logs, name), 'utf8'));
    }
  }
  // msedgedriver waits for a DevToolsActivePort file in the WebView2 user data
  // folder; show where one was written, if anywhere.
  const webViewData = path.join(process.env.LOCALAPPDATA ?? '', 'cropa-e2e');
  if (fs.existsSync(webViewData)) {
    const found = fs
      .readdirSync(webViewData, { recursive: true })
      .filter((name) => path.basename(String(name)) === 'DevToolsActivePort');
    console.error(`--- DevToolsActivePort under ${webViewData}: ${found.join(', ') || 'none'} ---`);
  }
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try {
      await webdriver('DELETE', `/session/${sessionId}`, undefined, 15_000);
    } catch {
      // The app is killed below anyway.
    }
  }
  if (driver?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(driver.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
  // WebView2 may hold files for a moment; a leftover temp folder is harmless.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignored
  }
}

async function waitFor(what, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    let value;
    try {
      value = await check();
    } catch (error) {
      // Only errors marked as transient are retried; others abort at once.
      if (!(error instanceof PollError)) throw error;
      lastError = error;
    }
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function webdriver(method, route, body, timeoutMs = 30_000) {
  const response = await fetch(`${DRIVER}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route} failed: ${JSON.stringify(json)}`);
  return json;
}

async function executeScript(script) {
  const { value } = await webdriver('POST', `/session/${sessionId}/execute/sync`, { script, args: [] });
  return value;
}

/** The WebDriver id of the element matching `selector`. */
async function findElement(selector) {
  const { value } = await webdriver('POST', `/session/${sessionId}/element`, {
    using: 'css selector',
    value: selector,
  });
  return Object.values(value)[0];
}

/** One background pixel of the preview canvas, as `[r, g, b, a]`. */
function samplePreview() {
  return executeScript(`
    const canvas = document.querySelector('[data-testid="editor-preview"]');
    const x = Math.floor(canvas.width / 2);
    const y = Math.floor(canvas.height * ${BAND_Y});
    return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
  `);
}

function hexColour(hex) {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

/**
 * A minimal PNG reader for 8-bit, non-interlaced RGB or RGBA images, which is
 * what the fixture and the canvas encoder produce. Throws on anything else, or
 * on a file cut short.
 */
function decodePng(file) {
  assert.ok(file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'not a PNG');
  let header;
  const idat = [];
  for (let at = 8; at < file.length; ) {
    const length = file.readUInt32BE(at);
    const type = file.toString('latin1', at + 4, at + 8);
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = data;
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    at += 12 + length;
  }
  assert.ok(header, 'PNG without IHDR');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, colourType, , , interlace] = header.subarray(8, 13);
  assert.ok(depth === 8 && (colourType === 2 || colourType === 6) && interlace === 0, 'unsupported PNG');
  const channels = colourType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? rows[y * stride + i - channels] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? rows[(y - 1) * stride + i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      rows[y * stride + i] = (line[i] + predictor) & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const at = y * stride + x * channels;
      return [rows[at], rows[at + 1], rows[at + 2], channels === 4 ? rows[at + 3] : 255];
    },
  };
}

