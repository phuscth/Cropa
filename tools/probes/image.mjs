// Image in: a generated 256x128 PNG (left half red, right half blue) sent with
// `codex exec -i <file>` or as a base64 image block in Claude Code's
// stream-json input. The answer should name red, then blue.
//
//   node tools/probes/image.mjs codex|claude

import fs from 'node:fs';
import path from 'node:path';

import { cliFromArgv, printEvents, redact, removeDir, tempDir, twoColourPng } from './lib.mjs';
import { turn } from './turn.mjs';

const cli = cliFromArgv();
const cwd = tempDir(`image-${cli}`);
try {
  const image = path.join(cwd, 'input.png');
  fs.writeFileSync(image, twoColourPng());
  const result = await turn(cli, {
    label: `image-${cli}`,
    cwd,
    user: 'The attached image has a left half and a right half. Reply with one line: "left=<colour> right=<colour>", using basic colour names.',
    image,
  });
  printEvents(result);
  const text = String(result.answer?.text ?? '').toLowerCase();
  console.log(`\nanswer: ${redact(result.answer?.text)}`);
  console.log(`image understood: ${/left\W*red/.test(text) && /right\W*blue/.test(text)}`);
} finally {
  removeDir(cwd);
}
