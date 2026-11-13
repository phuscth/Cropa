/**
 * Error kinds a transport run can end with. Mirrors `AgentError` in the
 * `cropa-agent` crate; keep both lists in step.
 */
export const AGENT_ERROR_KINDS = [
  'NotInstalled',
  'NotLoggedIn',
  'UsageLimit',
  'Unsupported',
  'Timeout',
  'Protocol',
  'Cancelled',
] as const;

export type AgentErrorKind = (typeof AGENT_ERROR_KINDS)[number];

/** Kinds a task run adds on top of the transport's. */
export const TASK_ERROR_KINDS = ['InvalidOutput', 'Locked'] as const;

export type TaskErrorKind = (typeof TASK_ERROR_KINDS)[number];

export type AiErrorKind = AgentErrorKind | TaskErrorKind;

export function isAgentErrorKind(value: unknown): value is AgentErrorKind {
  return typeof value === 'string' && (AGENT_ERROR_KINDS as readonly string[]).includes(value);
}

/** What a transport rejects with. */
export class AgentError extends Error {
  readonly kind: AgentErrorKind;

  constructor(kind: AgentErrorKind, message?: string) {
    super(message ?? kind);
    this.name = 'AgentError';
    this.kind = kind;
  }
}

/**
 * Maps anything a transport rejected with to a kind. Plain objects with a
 * known `kind` count too: the desktop side receives them from Rust commands.
 */
export function toAgentErrorKind(err: unknown, signal?: AbortSignal): AgentErrorKind {
  if (signal?.aborted) return 'Cancelled';
  if (err instanceof AgentError) return err.kind;
  if (typeof err === 'object' && err !== null && 'kind' in err && isAgentErrorKind(err.kind)) {
    return err.kind;
  }
  return 'Protocol';
}

/**
 * What a task's `postprocess` throws when the model's answer is wrong in a way another answer
 * could fix (for example a source that is empty or too long). The run sends the message back once.
 * Any other error from `postprocess` ends the run without a retry.
 */
export class TaskOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskOutputError';
  }
}
