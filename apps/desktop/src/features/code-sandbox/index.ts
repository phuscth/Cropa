export { checkModule, framesMatch } from './check-module.ts';
export type { CheckModuleOptions, ModuleCheck } from './check-module.ts';
export { CodeSandboxError } from './errors.ts';
export type { CodeSandboxErrorKind } from './errors.ts';
export { createCodeSandbox, DEFAULT_FRAME_TIMEOUT_MS } from './sandbox.ts';
export type { CodeFrame, CodeSandbox, CodeSandboxOptions, CodeScene } from './sandbox.ts';
export { MAX_SOURCE_BYTES } from './worker-source.ts';
export { createSandboxFrameSource } from './frame-source.ts';
export type { SandboxFrameSource } from './frame-source.ts';
