import { keyLetter } from '../keyboard.ts';

export type Tool = 'select' | 'arrow' | 'rect' | 'text' | 'step' | 'blur' | 'pixelate';

export const TOOLS: readonly Tool[] = ['select', 'arrow', 'rect', 'text', 'step', 'blur', 'pixelate'];

/** The letter that selects each tool. */
export const TOOL_KEYS: Record<Tool, { key: string }> = {
  select: { key: 'v' },
  arrow: { key: 'a' },
  rect: { key: 'r' },
  text: { key: 't' },
  step: { key: 'n' },
  blur: { key: 'b' },
  pixelate: { key: 'p' },
};

/** The tool a key press selects; null when a modifier is held or no tool uses the key. */
export function toolForKey(event: {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Tool | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const letter = keyLetter(event);
  return TOOLS.find((tool) => TOOL_KEYS[tool].key === letter) ?? null;
}
