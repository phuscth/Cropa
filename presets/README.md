# Background presets

Every background that ships with Cropa is one JSON file in this folder. The
built-in presets are simply the first files; yours is added the same way.

## Add a preset

1. Create `presets/<id>.json`. The file name is the preset's `id`.
2. Add the import line and the list entry in
   [`packages/core/src/presets/builtin.ts`](../packages/core/src/presets/builtin.ts).
3. Run `pnpm check:presets` and `pnpm test`.
4. The contact-sheet snapshot (`packages/core/src/render/__snapshots__/presets-contact-sheet.png`)
   changes. Regenerate it with `UPDATE_SNAPSHOTS=1 pnpm --filter @cropa/core test`
   and attach a preview of the new tile to the pull request.

CI checks the schema and the size only. Maintainers judge the look: calm
colours, smooth gradients and subtle noise read well behind a screenshot.

## The file

```json
{
  "version": 1,
  "id": "warm-dusk",
  "name": { "en": "Warm dusk", "vi": "Hoàng hôn ấm" },
  "background": {
    "version": 1,
    "viewBox": [0, 0, 1000, 1000],
    "layers": [
      {
        "type": "linear",
        "angle": 135,
        "stops": [
          { "offset": 0, "color": "#ff8a7a" },
          { "offset": 1, "color": "#ffc371" }
        ]
      },
      { "type": "noise", "opacity": 0.05, "grain": 1.5, "seed": 3 }
    ],
    "animation": { "type": "none", "speed": 1, "loop": true, "durationMs": 4000 }
  }
}
```

The format is defined in
[`packages/core/src/presets/file.ts`](../packages/core/src/presets/file.ts) and
the `background` object in
[`packages/core/src/schema/background.ts`](../packages/core/src/schema/background.ts).
Unknown keys are rejected.

## Rules

- **`id`**: 2 to 40 characters, lowercase letters and digits joined by single
  dashes (`warm-dusk`). Unique, and equal to the file name without `.json`.
- **`name`**: `en` is required. `vi` is optional; Cropa shows the English name
  when it is missing. Each is 1 to 40 characters, with no leading or trailing
  space and no control characters.
- **Size**: at most 16 KiB (16384 bytes) of UTF-8 text.
- **No `image` layers.** Image files are not accepted, so a preset is made of
  gradients, mesh, noise, shapes and blur only.
- Only `.json` files and this README live in the folder.

## Licence

By contributing a preset you license it under the project's MIT licence.
