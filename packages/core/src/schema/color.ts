import { z } from 'zod';

/** `#rrggbb` or `#rrggbbaa`. No CSS colour names or functions: the data may come from AI output. */
export const Hex = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected #rrggbb or #rrggbbaa');

/** Names an image held by the app (`builtin:name` or `user:name`); the renderer resolves it. */
export const Ref = z
  .string()
  .regex(/^(?:builtin|user):[A-Za-z0-9._-]{1,128}$/, 'expected builtin:<name> or user:<name>');

/** Names a cut-out image made for the open screenshot (`mask:<name>`); the app resolves it. */
export const MaskRef = z
  .string()
  .regex(/^mask:[A-Za-z0-9._-]{1,128}$/, 'expected mask:<name>');

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

/** Parses a validated `#rrggbb[aa]` string. Returns null for anything else. */
export function parseHex(hex: string): Rgba | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!m) return null;
  return {
    r: parseInt(m[1] ?? '0', 16),
    g: parseInt(m[2] ?? '0', 16),
    b: parseInt(m[3] ?? '0', 16),
    a: m[4] === undefined ? 1 : parseInt(m[4], 16) / 255,
  };
}
