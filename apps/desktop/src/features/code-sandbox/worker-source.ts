import { CodeSandboxError } from './errors.ts';
import runtime from './worker-runtime.js?raw';

export const MAX_SOURCE_BYTES = 64 * 1024;

export function sourceBytes(source: string): number {
  return new TextEncoder().encode(source).length;
}

export function usesThree(source: string): boolean {
  return /\bTHREE\s*[.[]/.test(source);
}

const EXPORT_DEFAULT = /^\s*export\s+default\b/m;
const IMPORT_STATEMENT = /^\s*import(?:\s*[{*"'(]|\s+[\w$])/m;
const EXPORT_PREFIX = /^(\s*)export\s+(?=(?:const|let|var|function|async\s+function|class)\b)/gm;

/**
 * Builds the one classic script the sandbox worker runs: the runtime, three.js when the source uses
 * it, then the AI source wrapped so its top-level `meta`, `back` and `front` can be read back.
 */
export function buildWorkerSource(source: string, three: string | null): string {
  if (EXPORT_DEFAULT.test(source)) {
    throw new CodeSandboxError(
      'module-error',
      'export default is not supported. Declare const meta, function back(ctx, t, scene) and optionally function front(ctx, t, scene) at top level instead.',
    );
  }
  if (IMPORT_STATEMENT.test(source)) {
    throw new CodeSandboxError(
      'module-error',
      'import is not supported. Write one self-contained script; THREE is a global when the source mentions it.',
    );
  }
  const body = source.replace(EXPORT_PREFIX, '$1');
  return `${runtime}
;${three ?? ''}
;var __cropaModule, __cropaLoadError = null;
try { __cropaModule = (function () { "use strict";
${body}
;return { meta: typeof meta === "undefined" ? undefined : meta, back: typeof back === "undefined" ? undefined : back, front: typeof front === "undefined" ? undefined : front };
})(); } catch (error) { __cropaLoadError = error; }
__cropaStart(__cropaModule, __cropaLoadError, ${usesThree(source) ? 'true' : 'false'});
`;
}
