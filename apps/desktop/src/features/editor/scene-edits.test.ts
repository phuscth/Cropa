import { builtinPresets, defaultScene, migrateScene, outputSize, type Scene } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import {
  accept,
  applyBackground,
  backgroundImageRef,
  backgroundImageRefs,
  setBackgroundImage,
  withoutMissingImages,
  sameBackground,
  tryAccept,
  aspectPreset,
  ASPECT_PRESETS,
  backgroundAngle,
  backgroundBlur,
  backgroundColors,
  backgroundKind,
  BACKGROUND_KINDS,
  CAPTURE_REF,
  frameRanges,
  matchImageColor,
  platformMatches,
  presetRatio,
  setAspectRatio,
  setBackgroundAngle,
  setBackgroundBlur,
  setBackgroundColor,
  setBackgroundKind,
  setBorderColor,
  setBorderWidth,
  setPadding,
  setPlatformSize,
  setRadius,
  setShadowLevel,
  shadowLevel,
  SHADOW_LEVELS,
} from './scene-edits.ts';
import { canUndo, historyReducer, initHistory } from './history.ts';

const fresh = () => defaultScene({ width: 1200, height: 800 });
const expectValid = (scene: Scene) => {
  expect(migrateScene(scene).ok).toBe(true);
  return scene;
};
const withLayers = (scene: Scene, layers: Scene['background']['layers']): Scene => ({
  ...scene,
  background: { ...scene.background, layers },
});

describe('background kind', () => {
  it('reads the default scene as a linear gradient with two colours and an angle', () => {
    const { background } = fresh();
    expect(backgroundKind(background)).toBe('linear');
    expect(backgroundColors(background)).toEqual(['#6366f1', '#ec4899']);
    expect(backgroundAngle(background)).toBe(135);
    expect(backgroundBlur(background)).toBe(0);
  });

  it('reads a single transparent solid as none, and any other solid as solid', () => {
    const none = setBackgroundKind(fresh(), 'none');
    expect(backgroundKind(none.background)).toBe('none');
    expect(backgroundColors(none.background)).toEqual([]);
    const solid = withLayers(fresh(), [{ type: 'solid', color: '#ff000080' }]);
    expect(backgroundKind(solid.background)).toBe('solid');
    // Only exactly #00000000 means none; a fully transparent red is still a solid.
    const clear = withLayers(fresh(), [{ type: 'solid', color: '#ff000000' }]);
    expect(backgroundKind(clear.background)).toBe('solid');
    const upper = withLayers(fresh(), [{ type: 'solid', color: '#00000000' }]);
    expect(backgroundKind(upper.background)).toBe('none');
  });

  it('builds every kind as a valid scene', () => {
    for (const kind of BACKGROUND_KINDS) {
      const scene = expectValid(setBackgroundKind(fresh(), kind));
      expect(backgroundKind(scene.background)).toBe(kind);
    }
  });

  it('keeps the colours when the kind changes', () => {
    const solid = setBackgroundKind(fresh(), 'solid');
    expect(backgroundColors(solid.background)).toEqual(['#6366f1']);
    const radial = setBackgroundKind(solid, 'radial');
    expect(backgroundColors(radial.background)).toEqual(['#6366f1', '#6366f1']);

    const mesh = setBackgroundKind(fresh(), 'mesh');
    expect(backgroundColors(mesh.background)).toEqual(['#6366f1', '#ec4899', '#6366f1', '#ec4899']);
    const linear = setBackgroundKind(mesh, 'linear');
    expect(backgroundColors(linear.background)).toEqual(['#6366f1', '#ec4899']);

    const conic = setBackgroundKind(fresh(), 'conic');
    expect(backgroundColors(conic.background)).toEqual(['#6366f1', '#ec4899', '#6366f1']);
  });

  it('falls back to the default palette after none, and keeps blur across kinds', () => {
    const blurred = setBackgroundBlur(fresh(), 30);
    const radial = setBackgroundKind(blurred, 'radial');
    expect(backgroundBlur(radial.background)).toBe(30);
    const none = setBackgroundKind(radial, 'none');
    expect(backgroundBlur(none.background)).toBe(0);
    expect(backgroundColors(setBackgroundKind(none, 'linear').background)).toEqual([
      '#6366f1',
      '#ec4899',
    ]);
  });

  it('puts a blurred capture behind the image kind', () => {
    const scene = setBackgroundKind(fresh(), 'image');
    expect(scene.background.layers).toEqual([
      { type: 'image', ref: CAPTURE_REF, fit: 'cover' },
      { type: 'blur', radius: 24 },
    ]);
  });

  it('returns the same scene for the kind it already has', () => {
    const scene = fresh();
    expect(setBackgroundKind(scene, 'linear')).toBe(scene);
  });
});

describe('background colours, angle and blur', () => {
  const decorated = (): Scene =>
    withLayers(fresh(), [
      { type: 'solid', color: '#111111' },
      { type: 'linear', angle: 10, stops: [{ offset: 0, color: '#aa0000' }, { offset: 1, color: '#00aa00' }] },
      { type: 'noise', grain: 2, seed: 1 },
    ]);

  it('edits only the main layer of a multi-layer background', () => {
    const next = expectValid(setBackgroundColor(decorated(), 1, '#0000ff'));
    expect(next.background.layers[0]).toEqual({ type: 'solid', color: '#111111' });
    expect(next.background.layers[2]).toEqual({ type: 'noise', grain: 2, seed: 1 });
    expect(backgroundColors(next.background)).toEqual(['#aa0000', '#0000ff']);
    expect(backgroundAngle(setBackgroundAngle(next, 200).background)).toBe(200);
  });

  it('keeps the base of a mesh at the average of its colours', () => {
    const mesh = setBackgroundKind(fresh(), 'mesh');
    const next = expectValid(setBackgroundColor(mesh, 0, '#000000'));
    expect(backgroundColors(next.background)[0]).toBe('#000000');
    // Red: (0 + 236 + 99 + 236) / 4 = 142.75, which rounds to 0x8f; green and blue likewise.
    expect(next.background.layers[0]).toEqual({ type: 'solid', color: '#8f3e89' });
  });

  it('ignores an unknown colour index, the same colour, and an angle on a solid', () => {
    const scene = fresh();
    expect(setBackgroundColor(scene, 5, '#000000')).toBe(scene);
    expect(setBackgroundColor(scene, 0, '#6366f1')).toBe(scene);
    const solid = setBackgroundKind(scene, 'solid');
    expect(setBackgroundAngle(solid, 10)).toBe(solid);
  });

  it('clamps the angle', () => {
    expect(backgroundAngle(setBackgroundAngle(fresh(), 999).background)).toBe(360);
  });

  it('adds, replaces and removes a trailing blur layer and keeps the other layers', () => {
    const base = decorated();
    const added = expectValid(setBackgroundBlur(base, 20));
    expect(added.background.layers).toHaveLength(4);
    expect(backgroundBlur(added.background)).toBe(20);

    const replaced = expectValid(setBackgroundBlur(added, 40));
    expect(replaced.background.layers).toHaveLength(4);
    expect(backgroundBlur(replaced.background)).toBe(40);

    const removed = expectValid(setBackgroundBlur(replaced, 0));
    expect(removed.background.layers).toEqual(base.background.layers);
    expect(setBackgroundBlur(removed, 0)).toBe(removed);
  });

  it('does not blur a none background, and respects the 16-layer limit', () => {
    const none = setBackgroundKind(fresh(), 'none');
    expect(setBackgroundBlur(none, 10)).toBe(none);
    const full = withLayers(
      fresh(),
      Array.from({ length: 16 }, () => ({ type: 'solid' as const, color: '#000000' })),
    );
    expect(setBackgroundBlur(full, 10)).toBe(full);
  });

  it('matches the image colour with a plain background and no blur', () => {
    const scene = matchImageColor(setBackgroundBlur(fresh(), 30), '#102030');
    expectValid(scene);
    expect(scene.background.layers).toEqual([{ type: 'solid', color: '#102030' }]);
  });
});

describe('frame', () => {
  it('rounds and clamps the sliders and returns the same scene for no change', () => {
    const scene = fresh();
    expect(setPadding(scene, 20.6).frame.padding).toBe(21);
    expect(setPadding(scene, -5).frame.padding).toBe(0);
    expect(setRadius(scene, 1e9).frame.radius).toBe(4096);
    expect(setPadding(scene, scene.frame.padding)).toBe(scene);
  });

  it('reads the default shadows as medium and round-trips every level', () => {
    expect(shadowLevel(fresh())).toBe('medium');
    for (const level of SHADOW_LEVELS) {
      const scene = expectValid(setShadowLevel(fresh(), level));
      expect(shadowLevel(scene)).toBe(level);
    }
    expect(setShadowLevel(fresh(), 'none').frame.shadows).toEqual([]);
  });

  it('makes soft lighter and strong heavier than medium, and reports no level for custom shadows', () => {
    const blur = (level: 'soft' | 'medium' | 'strong') =>
      setShadowLevel(fresh(), level).frame.shadows[0]?.blur ?? 0;
    expect(blur('soft')).toBeLessThan(blur('medium'));
    expect(blur('strong')).toBeGreaterThan(blur('medium'));
    const custom = { ...fresh(), frame: { ...fresh().frame, shadows: [{ x: 1, y: 2, blur: 3, color: '#000000' }] } };
    expect(shadowLevel(custom)).toBeNull();
  });

  it('removes the border at width 0 and keeps its colour otherwise', () => {
    const bordered = expectValid(setBorderWidth(setBorderColor(fresh(), '#ff0000'), 4));
    expect(bordered.frame.border).toEqual({ width: 4, color: '#ff0000' });
    expect(setBorderWidth(bordered, 0).frame.border).toBeNull();
    expect(setBorderWidth(fresh(), 3).frame.border).toEqual({ width: 3, color: '#ffffff' });
  });

  it('brings a border back in its last colour when the width passes through 0', () => {
    const red = setBorderWidth(setBorderColor(fresh(), '#ff0000'), 4);
    const gone = setBorderWidth(red, 0);
    expect(gone.frame.border).toBeNull();
    expect(setBorderWidth(gone, 2, '#ff0000').frame.border).toEqual({ width: 2, color: '#ff0000' });
    expect(setBorderWidth(red, 6, '#00ff00').frame.border?.color).toBe('#ff0000');
  });

  it('creates a thin border when a colour is set on none', () => {
    const scene = expectValid(setBorderColor(fresh(), '#00ff00'));
    // 0.2% of the longest side (1200 px).
    expect(scene.frame.border).toEqual({ width: 2, color: '#00ff00' });
  });

  it('scales the slider ranges with the screenshot', () => {
    const small = frameRanges({ width: 800, height: 600 });
    const large = frameRanges({ width: 3840, height: 2160 });
    expect(large.padding[1]).toBeGreaterThan(small.padding[1]);
    expect(small.padding).toEqual([0, 200]);
  });
});

describe('accept', () => {
  it('rejects a padding that pushes the output over 16384 px', () => {
    const scene = fresh();
    const huge = setPadding(scene, 8192);
    expect(Math.max(outputSize(huge).width, outputSize(huge).height)).toBeGreaterThan(16384);
    expect(accept(scene, huge)).toBe(scene);
    const ok = setPadding(scene, 100);
    expect(accept(scene, ok)).toBe(ok);
    // A rejected change is null; a change that does nothing is the same scene.
    expect(tryAccept(scene, huge)).toBeNull();
    expect(tryAccept(scene, scene)).toBe(scene);
  });
});

describe('aspect ratio', () => {
  it('maps every preset back, and a free ratio to custom', () => {
    for (const preset of ASPECT_PRESETS) {
      if (preset === 'custom') continue;
      const scene = expectValid(setAspectRatio(fresh(), presetRatio(preset)));
      expect(aspectPreset(scene)).toBe(preset);
    }
    expect(aspectPreset(setAspectRatio(fresh(), [1.85, 1]))).toBe('custom');
    expect(aspectPreset(setAspectRatio(fresh(), [8, 6]))).toBe('4:3');
  });

  it('returns the same scene for the same ratio', () => {
    const scene = setAspectRatio(fresh(), [16, 9]);
    expect(setAspectRatio(scene, [16, 9])).toBe(scene);
    const auto = fresh();
    expect(setAspectRatio(auto, null)).toBe(auto);
  });
});

describe('platform sizes', () => {
  it('leaves a platform size when a plain ratio is chosen', () => {
    const platform = setPlatformSize(fresh(), 'x');
    expect(platform.output.width).toBe(1920);
    const plain = setAspectRatio(platform, [16, 9]);
    expect(plain.output).toEqual({ aspectRatio: [16, 9], width: null });
    expect(platformMatches(plain, 'x')).toBe(false);
  });

  it('matches facebook and threads alike, and only the platform set', () => {
    const scene = setPlatformSize(fresh(), 'facebook');
    expect(platformMatches(scene, 'facebook')).toBe(true);
    expect(platformMatches(scene, 'threads')).toBe(true);
    expect(platformMatches(scene, 'linkedin')).toBe(false);
  });

  it('returns the same scene when the platform size is already set', () => {
    const scene = setPlatformSize(fresh(), 'linkedin');
    expect(setPlatformSize(scene, 'linkedin')).toBe(scene);
  });
});

describe('background presets', () => {
  it('replaces only the background', () => {
    const scene = fresh();
    const background = builtinPresets[0]?.background;
    if (!background) throw new Error('no built-in preset');
    const next = applyBackground(scene, background);
    expect(next.background).toBe(background);
    expect({ ...next, background: scene.background }).toEqual(scene);
  });

  it('returns the same scene for an equal background', () => {
    const scene = fresh();
    expect(applyBackground(scene, structuredClone(scene.background))).toBe(scene);
    expect(sameBackground(scene.background, structuredClone(scene.background))).toBe(true);
  });

  it('is one undo step through the history', () => {
    const start = fresh();
    const background = builtinPresets[0]?.background;
    if (!background || sameBackground(start.background, background)) throw new Error('bad fixture');
    let h = initHistory(start);
    h = historyReducer(h, { type: 'edit', scene: (s) => applyBackground(s, background) });
    expect(h.present.background).toBe(background);
    h = historyReducer(h, { type: 'undo' });
    expect(h.present).toBe(start);
    expect(canUndo(h)).toBe(false);
  });

});

describe('image backgrounds', () => {
  const layersOf = (scene: Scene) => scene.background.layers;

  it('starts a picture without blur and the screenshot with a soft one', () => {
    const picture = expectValid(setBackgroundImage(fresh(), 'builtin:silk'));
    expect(layersOf(picture)).toEqual([{ type: 'image', ref: 'builtin:silk', fit: 'cover' }]);
    expect(backgroundKind(picture.background)).toBe('image');
    expect(backgroundImageRef(picture.background)).toBe('builtin:silk');
    expect(backgroundBlur(picture.background)).toBe(0);

    const capture = expectValid(setBackgroundImage(fresh(), CAPTURE_REF));
    expect(backgroundImageRef(capture.background)).toBe(CAPTURE_REF);
    expect(backgroundBlur(capture.background)).toBeGreaterThan(0);
  });

  it('keeps the blur and the opacity when the image changes', () => {
    const start = withLayers(fresh(), [
      { type: 'image', ref: 'builtin:silk', fit: 'contain', opacity: 0.5 },
      { type: 'blur', radius: 40 },
    ]);
    const next = expectValid(setBackgroundImage(start, 'user:img-1f'));
    expect(layersOf(next)).toEqual([
      { type: 'image', ref: 'user:img-1f', fit: 'cover', opacity: 0.5 },
      { type: 'blur', radius: 40 },
    ]);
  });

  it('is the same scene when that image is already chosen', () => {
    const scene = setBackgroundImage(fresh(), 'builtin:dunes');
    expect(setBackgroundImage(scene, 'builtin:dunes')).toBe(scene);
  });

  it('does not take the blur of the gradient it replaces', () => {
    const blurred = setBackgroundBlur(fresh(), 30);
    const next = setBackgroundImage(blurred, 'builtin:bokeh');
    expect(backgroundBlur(next.background)).toBe(0);
  });

  it('lists each image ref once and leaves out the screenshot', () => {
    const spec = withLayers(fresh(), [
      { type: 'image', ref: CAPTURE_REF, fit: 'cover' },
      { type: 'image', ref: 'user:img-1', fit: 'cover' },
      { type: 'image', ref: 'user:img-1', fit: 'contain' },
      { type: 'image', ref: 'builtin:silk', fit: 'cover' },
    ]).background;
    expect(backgroundImageRefs(spec)).toEqual(['user:img-1', 'builtin:silk']);
    expect(backgroundImageRefs(fresh().background)).toEqual([]);
  });

  it('swaps a missing image for plain grey of the same opacity and leaves the rest alone', () => {
    const spec = withLayers(fresh(), [
      { type: 'solid', color: '#112233' },
      { type: 'image', ref: 'user:img-gone', fit: 'cover', opacity: 0.4 },
      { type: 'image', ref: 'builtin:silk', fit: 'cover' },
      { type: 'blur', radius: 8 },
    ]).background;
    const next = withoutMissingImages(spec, ['user:img-gone']);
    expect(next.layers).toEqual([
      { type: 'solid', color: '#112233' },
      { type: 'solid', color: '#d4d4d8', opacity: 0.4 },
      { type: 'image', ref: 'builtin:silk', fit: 'cover' },
      { type: 'blur', radius: 8 },
    ]);
    expect(migrateScene({ ...fresh(), background: next }).ok).toBe(true);
    expect(withoutMissingImages(spec, [])).toBe(spec);
  });
});
