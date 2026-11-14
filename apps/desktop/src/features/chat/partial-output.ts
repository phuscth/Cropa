const SOURCE_KEY = /"source"\s*:\s*"/;

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** The code unit of a `\uXXXX` escape starting at `at`, or undefined when it is cut or not hex. */
function unicodeEscape(raw: string, at: number): number | undefined {
  if (raw[at] !== '\\' || raw[at + 1] !== 'u') return undefined;
  const hex = raw.slice(at + 2, at + 6);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? Number.parseInt(hex, 16) : undefined;
}

/**
 * The `source` string of the structured answer while it is still being written. `raw` is the
 * JSON text so far and usually ends mid-way: inside the string, in the middle of an escape, or
 * before the field began. What can be decoded is returned; the rest waits for the next chunk.
 */
export function partialSource(raw: string): string {
  const key = SOURCE_KEY.exec(raw);
  if (!key) return '';
  let out = '';
  let i = key.index + key[0].length;
  while (i < raw.length) {
    const char = raw.charAt(i);
    if (char === '"') break;
    if (char !== '\\') {
      out += char;
      i += 1;
      continue;
    }
    const next = raw.charAt(i + 1);
    if (next === '') break;
    if (next !== 'u') {
      // An unknown escape is kept as written rather than dropped.
      out += SIMPLE_ESCAPES[next] ?? next;
      i += 2;
      continue;
    }
    const unit = unicodeEscape(raw, i);
    if (unit === undefined) break;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // A high surrogate is shown only together with its low half.
      const low = unicodeEscape(raw, i + 6);
      if (low === undefined || low < 0xdc00 || low > 0xdfff) break;
      out += String.fromCharCode(unit, low);
      i += 12;
      continue;
    }
    out += String.fromCharCode(unit);
    i += 6;
  }
  return out;
}
