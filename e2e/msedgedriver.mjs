// Downloads the pinned msedgedriver once and checks its SHA-256. tauri-driver
// needs it to drive the WebView2 of the app. Run it directly to print the path.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must match the WebView2 runtime's major version. To move to a new one, take
// the driver from https://developer.microsoft.com/microsoft-edge/tools/webdriver/
// and set the version and the SHA-256 of `edgedriver_win64.zip`.
export const VERSION = '157.0.4341.46';
const SHA256 = 'ad94f3a90cb9ac70fc691d83ac98fdcadd2abb94c58cae33020aa2b497519420';
export const msedgedriverMajor = Number(VERSION.split('.')[0]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'target', 'e2e', `msedgedriver-${VERSION}`);

/** The path of `msedgedriver.exe`, downloaded into `target/e2e/` on first use. */
export async function ensureMsedgedriver() {
  const exe = path.join(folder, 'msedgedriver.exe');
  if (fs.existsSync(exe)) return exe;

  fs.mkdirSync(folder, { recursive: true });
  const zip = path.join(folder, 'edgedriver_win64.zip');
  const url = `https://msedgedriver.microsoft.com/${VERSION}/edgedriver_win64.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(zip, bytes);

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== SHA256) {
    fs.rmSync(zip, { force: true });
    throw new Error(`msedgedriver ${VERSION} does not match its pinned hash.\n  expected ${SHA256}\n  got      ${actual}`);
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
