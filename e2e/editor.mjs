// End-to-end smoke test of the editor: the app opens a fixture image in the
// editor, and the preview canvas shows it unmirrored. Drives the app through
// tauri-driver (WebDriver) and msedgedriver. Run with `pnpm e2e:editor` after
// `pnpm e2e:build`.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, ensureMsedgedriver, msedgedriverMajor } from './msedgedriver.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = process.env.CROPA_E2E_APP ?? path.join(root, 'target', 'e2e-app', 'debug', 'cropa-desktop.exe');
const fixture = path.join(root, 'e2e', 'fixtures', 'two-colours.png');
const DRIVER = 'http://127.0.0.1:4444';
const WEBVIEW2_GUID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

const MAGENTA = [255, 0, 255];
const CYAN = [0, 200, 255];

const dir = path.join(os.tmpdir(), `cropa-e2e-editor-${process.pid}`);
let driver;
let driverOutput = '';
let sessionId;

try {
  if (!fs.existsSync(app)) throw new Error(`${app} is missing; run \`pnpm e2e:build\` first.`);
  checkWebView2Version();
  const msedgedriver = await ensureMsedgedriver();

  // A capture key the user's own Cropa does not hold, so no Settings window
  // opens over the editor.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config', 'settings.json'),
    JSON.stringify({ version: 4, captureShortcut: 'Ctrl+Alt+Shift+F9', autostartAsked: true }),
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

  // TODO: once the editor has its preset panel and export, also check that
  // choosing another background preset in the sidebar changes the preview's
  // background pixels, and that Ctrl+S writes a PNG of the expected size into
  // the save folder. Seed `saveFolder` in settings.json with a folder inside
  // the test folder, so the first Ctrl+S does not open the folder picker.
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

class PollError extends Error {
  constructor(cause) {
    super(String(cause?.message ?? cause));
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

function checkWebView2Version() {
  const keys = [
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`,
    `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`,
    `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`,
  ];
  let version;
  for (const key of keys) {
    try {
      const output = execFileSync('reg', ['query', key, '/v', 'pv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      version = output.match(/pv\s+REG_SZ\s+(\S+)/)?.[1];
      if (version) break;
    } catch {
      // Try the next location.
    }
  }
  if (!version) {
    console.warn('Warning: could not read the WebView2 version; continuing.');
    return;
  }
  console.log(`WebView2 ${version}, msedgedriver ${VERSION}`);
  if (Number(version.split('.')[0]) !== msedgedriverMajor) {
    throw new Error(
      `WebView2 is ${version} but msedgedriver is pinned to ${VERSION}; set VERSION and SHA256 in e2e/msedgedriver.mjs ` +
        'to the matching driver from https://developer.microsoft.com/microsoft-edge/tools/webdriver/',
    );
  }
}
