// @cropa/ai: AI tasks (prompt, schema, validate, retry, fallback) and evals.
// It knows a provider only by name and capabilities, and spawns nothing.

export {
  AGENT_ERROR_KINDS,
  TASK_ERROR_KINDS,
  AgentError,
  TaskOutputError,
  isAgentErrorKind,
  toAgentErrorKind,
} from './errors.ts';
export type { AgentErrorKind, AiErrorKind, TaskErrorKind } from './errors.ts';

export type {
  Effort,
  JsonSchema,
  Transport,
  TransportEvent,
  TransportOptions,
  TransportOutput,
  TransportRequest,
} from './transport.ts';
export { MockTransport } from './mock-transport.ts';
export type { MockScript, MockStep } from './mock-transport.ts';

export { defineTask } from './task.ts';
export type { Capability, Provider, Task, TaskDefinition, TaskPrompt } from './task.ts';
export { runTask } from './run-task.ts';
export type {
  RunTaskOptions,
  TaskEvent,
  TaskNotice,
  TaskResult,
  TaskRun,
  Validation,
} from './run-task.ts';

export { paletteNameTask } from './tasks/palette-name.ts';
export type { PaletteName, PaletteNameInput } from './tasks/palette-name.ts';

export {
  backgroundTask,
  judgeModuleCheck,
  BACKGROUND_EXAMPLES,
  MAX_BACKGROUND_SOURCE_BYTES,
} from './tasks/background.ts';
export type { BackgroundExample, BackgroundInput, ModuleCheckResult } from './tasks/background.ts';
