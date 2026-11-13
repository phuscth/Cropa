import { BackgroundSpec, builtinPresets, closestPreset } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import { MockTransport } from '../mock-transport.ts';
import { runTask } from '../run-task.ts';

import {
  BACKGROUND_EXAMPLES,
  MAX_BACKGROUND_SOURCE_BYTES,
  backgroundTask,
  judgeModuleCheck,
  type BackgroundInput,
} from './background.ts';

const input: BackgroundInput = {
  description: 'a meadow in light wind',
  palette: [
    { hex: '#2f6f3e', weight: 0.5 },
    { hex: '#a8d5ba', weight: 0.3 },
    { hex: '#f4f1de', weight: 0.2 },
  ],
  frame: {
    width: 1920,
    height: 1080,
    frame: { x: 240, y: 135, width: 1440, height: 810, radius: 16, border: 2 },
  },
};

const GOOD = 'const meta = { durationMs: 4000 };\nfunction back(ctx, t, scene) {}';

function codeLayer(spec: BackgroundSpec) {
  return spec.layers.find((layer) => layer.type === 'code');
}

describe('backgroundTask prompt', () => {
  const prompt = backgroundTask.buildPrompt(input);

  it('states the module contract', () => {
    for (const keyword of [
      'meta',
      'back(ctx, t, scene)',
      'front',
      'Math.random',
      'THREE.Clock',
      '250 ms',
      '64 KiB',
    ]) {
      expect(prompt.system).toContain(keyword);
    }
  });

  it('carries every example module', () => {
    for (const example of BACKGROUND_EXAMPLES) {
      expect(prompt.system).toContain(example.name);
      expect(prompt.system).toContain(example.source.trimEnd());
    }
  });

  it('describes the request, the palette and the frame', () => {
    expect(prompt.user).toContain('a meadow in light wind');
    for (const hex of ['#2f6f3e', '#a8d5ba', '#f4f1de']) expect(prompt.user).toContain(hex);
    expect(prompt.user).toContain('50%');
    for (const n of ['1920x1080', 'x 240', 'y 135', 'width 1440', 'height 810', 'radius 16', 'border 2']) {
      expect(prompt.user).toContain(n);
    }
    expect(prompt.user).not.toContain('current module');
  });

  it('cuts a long description to 500 characters and trims it', () => {
    const long = backgroundTask.buildPrompt({ ...input, description: `  ${'x'.repeat(800)}  ` });
    expect(long.user).toContain('x'.repeat(500));
    expect(long.user).not.toContain('x'.repeat(501));
  });

  it('includes the current source only when refining', () => {
    const refine = backgroundTask.buildPrompt({ ...input, currentSource: GOOD });
    expect(refine.user).toContain('change it as asked and return the whole module');
    expect(refine.user).toContain(GOOD);
  });
});

describe('backgroundTask output', () => {
  it('asks for source, durationMs and threeD without size limits', () => {
    const schema = backgroundTask.jsonSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    };
    expect([...schema.required].sort()).toEqual(['durationMs', 'source', 'threeD']);
    expect(schema.additionalProperties).toBe(false);
    for (const property of Object.values(schema.properties)) {
      for (const key of ['minimum', 'maximum', 'minLength', 'maxLength']) {
        expect(property).not.toHaveProperty(key);
      }
    }
  });
});

describe('backgroundTask postprocess', () => {
  const run = (patch: Partial<{ source: string; durationMs: number; threeD: boolean }> = {}) =>
    backgroundTask.postprocess({ source: GOOD, durationMs: 4000, threeD: false, ...patch }, { input });

  it('clamps the duration to the code layer range and rounds it', () => {
    expect(codeLayer(run({ durationMs: 500 }))).toMatchObject({ durationMs: 1000 });
    expect(codeLayer(run({ durationMs: 99999 }))).toMatchObject({ durationMs: 20000 });
    expect(codeLayer(run({ durationMs: 4321.6 }))).toMatchObject({ durationMs: 4322 });
    expect(codeLayer(run({ durationMs: Number.NaN }))).toMatchObject({ durationMs: 4000 });
  });

  it('strips one surrounding code fence', () => {
    for (const fence of ['```js', '```javascript', '```']) {
      expect(codeLayer(run({ source: `${fence}\n${GOOD}\n\`\`\`\n` }))).toMatchObject({ source: GOOD });
    }
  });

  it('rejects an empty source and one over 64 KiB in bytes', () => {
    expect(() => run({ source: '  \n ' })).toThrow(/empty/);
    // Two bytes per character, so the byte count and not the length decides.
    const wide = 'é'.repeat(MAX_BACKGROUND_SOURCE_BYTES / 2 + 1);
    expect(wide.length).toBeLessThan(MAX_BACKGROUND_SOURCE_BYTES);
    expect(() => run({ source: wide })).toThrow(/65538 bytes.*65536/);
    expect(() => run({ source: 'a'.repeat(MAX_BACKGROUND_SOURCE_BYTES + 1) })).toThrow(/limit/);
    expect(codeLayer(run({ source: 'a'.repeat(MAX_BACKGROUND_SOURCE_BYTES) }))).toBeDefined();
  });

  it('marks a source that mentions THREE as 3D even when the answer says it is not', () => {
    const source = `${GOOD}\nconst scene = new THREE.Scene();`;
    expect(codeLayer(run({ source, threeD: false }))).toMatchObject({ threeD: true });
    expect(codeLayer(run({ threeD: false }))).toMatchObject({ threeD: false });
  });

  it('appends the code layer to the closest preset and stays a valid background', () => {
    const result = run();
    const preset = builtinPresets.find((p) => p.id === closestPreset(input.palette, builtinPresets));
    expect(preset).toBeDefined();
    const base = preset?.background.layers ?? [];
    expect(result.layers.slice(0, -1)).toEqual(base);
    expect(result.layers.at(-1)).toEqual({ type: 'code', source: GOOD, durationMs: 4000, threeD: false });
    expect(BackgroundSpec.safeParse(result).success).toBe(true);
  });
});

describe('backgroundTask fallback', () => {
  it('is the background of the closest preset', () => {
    const preset = builtinPresets.find((p) => p.id === closestPreset(input.palette, builtinPresets));
    expect(backgroundTask.fallback(input)).toEqual(preset?.background);
    expect(backgroundTask.fallback(input)).toEqual(backgroundTask.fallback(input));
  });

  it('is the first built-in preset without a palette', () => {
    expect(backgroundTask.fallback({ ...input, palette: [] })).toEqual(builtinPresets[0]?.background);
  });
});

describe('judgeModuleCheck', () => {
  const ran = { ok: true, loops: true, maxFrameMs: 3, durationMs: 4000 };

  it('passes a module that ran and loops', () => {
    expect(judgeModuleCheck(ran)).toEqual({ ok: true });
  });

  it('sends a module error back as it is', () => {
    const error = { kind: 'timeout', message: 'Rendering the frame at t=0 took longer than 250 ms.' };
    expect(judgeModuleCheck({ ...ran, ok: false, loops: false, error })).toEqual({
      ok: false,
      message: error.message,
    });
  });

  it('asks for a periodic loop when the last frame differs from the first', () => {
    const verdict = judgeModuleCheck({ ...ran, loops: false });
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok ? '' : verdict.message).toContain('loop does not close');
  });

  it('does not retry when WebGL is missing', () => {
    const error = { kind: 'no-webgl', message: 'WebGL is not available here.' };
    expect(judgeModuleCheck({ ...ran, ok: false, loops: false, error })).toEqual({
      ok: false,
      retry: false,
      message: error.message,
    });
  });
});

describe('backgroundTask run', () => {
  const answer = (source: string) => ({ json: { source, durationMs: 4000, threeD: false } });
  const provider = { name: 'mock', capabilities: [] };

  it('sends an oversize first answer back with the limit and accepts the next one', async () => {
    const transport = new MockTransport([answer('a'.repeat(MAX_BACKGROUND_SOURCE_BYTES + 1)), answer(GOOD)]);
    const out = await runTask(backgroundTask, input, { transport, provider }).done;
    expect(out.source).toBe('ai');
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]?.prompt).toContain('65537 bytes');
    expect(transport.calls[1]?.prompt).toContain('did not pass the check');
  });

  it('ends on the fallback when the retry is empty too', async () => {
    const transport = new MockTransport([answer(' '), answer('')]);
    const out = await runTask(backgroundTask, input, { transport, provider }).done;
    expect(out.source).toBe('fallback');
    expect(out.notice?.kind).toBe('InvalidOutput');
  });
});
