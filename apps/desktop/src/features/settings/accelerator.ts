/** The subset of `KeyboardEvent` the recorder needs (keeps it testable). */
export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type RecordResult =
  | { kind: 'cancel' }
  | { kind: 'pending' }
  | { kind: 'done'; accelerator: string };

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
]);

/** `KeyboardEvent.code` → key name understood by Tauri's accelerator parser. */
function mainKey(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit?.[1]) return digit[1];
  return code;
}

/**
 * Turn a keydown into an accelerator such as `Alt+Shift+S`, layout
 * independent (uses `code`, not `key`). Modifier-only presses keep
 * recording; Esc without modifiers cancels. Validation of the result
 * (e.g. "needs a modifier") is left to Rust, the single source of truth.
 */
export function recordAccelerator(event: KeyLike): RecordResult {
  const hasModifier = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey;
  if (event.code === 'Escape' && !hasModifier) return { kind: 'cancel' };
  if (MODIFIER_CODES.has(event.code) || event.code === '') return { kind: 'pending' };

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');
  parts.push(mainKey(event.code));
  return { kind: 'done', accelerator: parts.join('+') };
}
