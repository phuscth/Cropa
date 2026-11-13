// Forced JSON: where the JSON lands in the event stream, and what a schema the
// CLI cannot use looks like.
//
//   node tools/probes/schema.mjs codex|claude [ok|loose|invalid]
//
// ok      the background schema (strict: every property required, no extras)
// loose   an optional property and no `additionalProperties: false`
// invalid not a JSON Schema at all (`"type": "nonsense"`)

import { BACKGROUND_SCHEMA, BACKGROUND_SYSTEM, BACKGROUND_USER, cliFromArgv, printEvents, redact, removeDir, tempDir } from './lib.mjs';
import { turn } from './turn.mjs';

const SCHEMAS = {
  ok: BACKGROUND_SCHEMA,
  loose: {
    type: 'object',
    required: ['layers'],
    properties: {
      layers: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, angle: { type: 'number' } } } },
      note: { type: 'string' },
    },
  },
  invalid: { type: 'object', properties: { layers: { type: 'nonsense' } }, required: ['layers'] },
};

const cli = cliFromArgv();
const which = process.argv[3] ?? 'ok';
if (!SCHEMAS[which]) {
  console.error(`Unknown case "${which}". Use one of: ${Object.keys(SCHEMAS).join(', ')}.`);
  process.exit(2);
}

const cwd = tempDir(`schema-${cli}`);
try {
  const result = await turn(cli, {
    label: `schema-${cli}-${which}`,
    cwd,
    system: BACKGROUND_SYSTEM,
    user: BACKGROUND_USER,
    schema: SCHEMAS[which],
  });
  console.log(`## ${cli} schema case "${which}"`);
  printEvents(result);
  console.log('\nanswer:', redact(JSON.stringify(result.answer, null, 2)));
  console.log(`first event ${result.firstEventMs} ms, final event ${result.finalMs} ms, exit ${result.exitMs} ms`);
} finally {
  removeDir(cwd);
}
