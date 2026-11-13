/** True when the key press belongs to a text field, which has its own undo. */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ['text', 'number', 'search', 'email', 'url', 'tel', 'password'].includes(target.type);
}

/**
 * The Latin letter a key press stands for, in lower case, or null. The character
 * the layout produces wins, so a Dvorak or Colemak user gets the letter on the keycap.
 * Only when that character is not a Latin letter (a Cyrillic layout, or Vietnamese
 * Telex composing) does the physical key decide.
 */
export function keyLetter(event: { key: string; code: string }): string | null {
  const key = event.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  const physical = /^Key([A-Z])$/.exec(event.code);
  return physical?.[1]?.toLowerCase() ?? null;
}
