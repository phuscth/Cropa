import midnight from '../../../../presets/midnight.json' with { type: 'json' };
import paper from '../../../../presets/paper.json' with { type: 'json' };
import slate from '../../../../presets/slate.json' with { type: 'json' };
import sunset from '../../../../presets/sunset.json' with { type: 'json' };
import ocean from '../../../../presets/ocean.json' with { type: 'json' };
import peach from '../../../../presets/peach.json' with { type: 'json' };
import mint from '../../../../presets/mint.json' with { type: 'json' };
import forest from '../../../../presets/forest.json' with { type: 'json' };
import aurora from '../../../../presets/aurora.json' with { type: 'json' };
import candy from '../../../../presets/candy.json' with { type: 'json' };
import lagoon from '../../../../presets/lagoon.json' with { type: 'json' };
import dusk from '../../../../presets/dusk.json' with { type: 'json' };
import ember from '../../../../presets/ember.json' with { type: 'json' };
import prism from '../../../../presets/prism.json' with { type: 'json' };

import { migratePresetFile } from './file.ts';
import type { Preset } from './file.ts';

const files: readonly unknown[] = [
  midnight,
  paper,
  slate,
  sunset,
  ocean,
  peach,
  mint,
  forest,
  aurora,
  candy,
  lagoon,
  dusk,
  ember,
  prism,
];

/**
 * The presets that ship with Cropa, in display order. A file that fails the schema is
 * left out rather than stopping the app; the tests and `pnpm check:presets` catch it.
 */
export const builtinPresets: readonly Preset[] = files.flatMap((file) => {
  const result = migratePresetFile(file);
  return result.ok ? [result.value] : [];
});
