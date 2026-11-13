import { composeWorkerSource } from './compose-worker.ts';
import runtime from './worker-runtime.js?raw';

export { MAX_SOURCE_BYTES, sourceBytes, usesThree } from './compose-worker.ts';

/** The script the sandbox worker runs, built on the bundled runtime. */
export function buildWorkerSource(source: string, three: string | null): string {
  return composeWorkerSource(runtime, source, three);
}
