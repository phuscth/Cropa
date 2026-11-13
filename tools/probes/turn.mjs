// One locked-down turn of either CLI, shared by the probes that spend quota.

import fs from 'node:fs';
import path from 'node:path';

import {
  CLAUDE_LOCKED,
  CODEX_LOCKED,
  claudeUserMessage,
  isFinal,
  parseJson,
  resolveCli,
  run,
} from './lib.mjs';

/**
 * Runs one turn in `cwd`.
 * - `system`, `user`: the prompt. Codex has no system prompt flag, so both go
 *   into stdin; Claude Code gets `--system-prompt`.
 * - `schema`: forced JSON (`--output-schema <file>` / `--json-schema <json>`).
 * - `image`: a PNG path inside `cwd` (`-i` / a base64 image block).
 * - `args`: replaces the locked-down argument set (the bait probe uses this).
 */
export async function turn(cli, { label, cwd, system, user, schema, image, args, onLine, timeoutMs }) {
  let fullArgs;
  let stdin;
  if (cli === 'codex') {
    fullArgs = [...(args ?? CODEX_LOCKED)];
    if (schema) {
      const schemaFile = path.join(cwd, 'output-schema.json');
      fs.writeFileSync(schemaFile, JSON.stringify(schema));
      fullArgs.push('--output-schema', schemaFile);
    }
    if (image) fullArgs.push('-i', image);
    stdin = system ? `${system}\n\n${user}` : user;
  } else {
    fullArgs = [...(args ?? CLAUDE_LOCKED)];
    if (system) fullArgs.push('--system-prompt', system);
    if (schema) fullArgs.push('--json-schema', JSON.stringify(schema));
    const blocks = [];
    if (image) {
      const data = fs.readFileSync(image).toString('base64');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    }
    blocks.push({ type: 'text', text: user });
    stdin = claudeUserMessage(blocks);
  }

  const result = await run({ label, exe: resolveCli(cli), args: fullArgs, stdin, cwd, onLine, timeoutMs });
  const events = result.lines.map((l) => ({ t: l.t, event: parseJson(l.text) }));
  // Codex can send a non-fatal `error` (a retry notice) mid-turn: prefer the
  // turn event, and fall back to the last `error` only when there is none.
  const final =
    events.find((e) => isFinal(cli, e.event) && e.event.type !== 'error') ??
    events.findLast((e) => isFinal(cli, e.event));
  return {
    ...result,
    events,
    firstEventMs: result.lines[0]?.t,
    finalMs: final?.t,
    final: final?.event,
    answer: answerOf(cli, events),
  };
}

/** Where the model's answer lands in each stream. */
export function answerOf(cli, events) {
  if (cli === 'claude') {
    const result = events.find((e) => e.event?.type === 'result')?.event;
    if (!result) return undefined;
    return { text: result.result, structured: result.structured_output, isError: result.is_error, subtype: result.subtype };
  }
  const messages = events
    .map((e) => e.event)
    .filter((e) => e?.type === 'item.completed' && e.item?.type === 'agent_message');
  const text = messages.at(-1)?.item?.text;
  return { text, structured: text === undefined ? undefined : parseJson(text) };
}
