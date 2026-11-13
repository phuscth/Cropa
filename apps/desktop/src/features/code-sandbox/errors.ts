export type CodeSandboxErrorKind =
  | 'timeout'
  | 'source-too-large'
  | 'module-error'
  | 'no-webgl'
  | 'sandbox-failed'
  | 'disposed';

export class CodeSandboxError extends Error {
  readonly kind: CodeSandboxErrorKind;

  constructor(kind: CodeSandboxErrorKind, message: string) {
    super(message);
    this.name = 'CodeSandboxError';
    this.kind = kind;
  }
}

/** Messages from AI code go back into a prompt, so they are cut to a size that stays useful. */
export const MAX_ERROR_MESSAGE_CHARS = 500;

export function truncateMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_CHARS
    ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : message;
}
