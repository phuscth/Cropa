// Downloads the msedgedriver that matches the installed WebView2 once and
// checks its SHA-256. tauri-driver needs it to drive the WebView2 of the app.
// Run it directly to print the path.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Known drivers and the SHA-256 of their `edgedriver_win64.zip`. A driver
// works only with a WebView2 of the same major version, and WebView2 updates
// about every four weeks, at different times on different machines. To add
// one, download
// https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip and hash it.
const DRIVERS = [
  { version: '156.0.4314.58', sha256: '2fd5acb3e5d8a5e35e0281f59d31292f261f21ba994fe025370331d522042ab5' },
  { version: '157.0.4341.46', sha256: 'ad94f3a90cb9ac70fc691d83ac98fdcadd2abb94c58cae33020aa2b497519420' },
];

const WEBVIEW2_GUID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const major = (version) => version.split('.')[0];

/** The installed WebView2 runtime version, from the registry. */
function webView2Version() {
  const keys = [
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`,
    `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`,
    `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_GUID}`,
  ];
  for (const key of keys) {
    try {
      const output = execFileSync('reg', ['query', key, '/v', 'pv'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const version = output.match(/pv\s+REG_SZ\s+(\S+)/)?.[1];
      if (version) return version;
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Could not read the WebView2 runtime version from the registry; is WebView2 installed?');
}

/** The known driver for `webView2`: the same version, else the newest of the same major. */
function pickDriver(webView2) {
  const exact = DRIVERS.find((driver) => driver.version === webView2);
  if (exact) return exact;
  const sameMajor = DRIVERS.filter((driver) => major(driver.version) === major(webView2));
  if (sameMajor.length > 0) return sameMajor.at(-1);
  throw new Error(
    `WebView2 is ${webView2}, and e2e/msedgedriver.mjs knows no msedgedriver for major version ${major(webView2)} ` +
      `(known: ${DRIVERS.map((driver) => driver.version).join(', ')}). Add ${webView2} to DRIVERS with the SHA-256 of ` +
      `https://msedgedriver.microsoft.com/${webView2}/edgedriver_win64.zip`,
  );
}

/** The path of the matching `msedgedriver.exe`, downloaded into `target/e2e/` on first use. */
export async function ensureMsedgedriver() {
  const webView2 = webView2Version();
  const { version, sha256 } = pickDriver(webView2);
  console.log(`WebView2 ${webView2}, msedgedriver ${version}`);

  const folder = path.join(root, 'target', 'e2e', `msedgedriver-${version}`);
  const exe = path.join(folder, 'msedgedriver.exe');
  if (fs.existsSync(exe)) return exe;

  fs.mkdirSync(folder, { recursive: true });
  const zip = path.join(folder, 'edgedriver_win64.zip');
  const url = `https://msedgedriver.microsoft.com/${version}/edgedriver_win64.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(zip, bytes);

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) {
    fs.rmSync(zip, { force: true });
    throw new Error(`msedgedriver ${version} does not match its pinned hash.\n  expected ${sha256}\n  got      ${actual}`);
  }

  // Windows' own tar reads zip files; the GNU tar that Git Bash may put first
  // on PATH does not.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-xf', zip, '-C', folder, 'msedgedriver.exe']);
  fs.rmSync(zip, { force: true });
  if (!fs.existsSync(exe)) throw new Error(`msedgedriver.exe is not in ${zip}`);
  return exe;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await ensureMsedgedriver());
}
