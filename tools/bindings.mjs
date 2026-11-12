// Regenerate apps/desktop/src/lib/bindings.ts from the Rust command surface
// without opening the app: runs the bindings test in write mode.
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'cargo',
  ['test', '--package', 'cropa-desktop', '--lib', '--', 'tests::bindings_are_up_to_date', '--exact'],
  { stdio: 'inherit', env: { ...process.env, CROPA_WRITE_BINDINGS: '1' } },
);
if (result.error) {
  console.error(`could not run cargo: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
