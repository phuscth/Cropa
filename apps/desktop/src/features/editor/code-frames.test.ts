import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCodeFrameSource } from './code-frames.ts';
import { devCodePreset } from './dev-code-stub.ts';

const sandboxSource = { tag: 'sandbox' };

vi.mock('../code-sandbox/index.ts', () => ({
  createSandboxFrameSource: vi.fn(() => sandboxSource),
}));

const stubSource = (() => {
  const layer = devCodePreset.background.layers.find((l) => l.type === 'code');
  if (layer?.type !== 'code') throw new Error('the dev preset has no code layer');
  return layer.source;
})();
const realSource = 'const meta = { durationMs: 4000 };\nfunction back(ctx, t, scene) {}';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createCodeFrameSource', () => {
  it('uses the sandbox for a real module', async () => {
    expect(await createCodeFrameSource(realSource)).toBe(sandboxSource);
  });

  it('uses the dev stub only for the stub marker, in development', async () => {
    const source = await createCodeFrameSource(stubSource);
    expect(source).not.toBe(sandboxSource);
    expect(source).toMatchObject({ load: expect.any(Function) as unknown, renderFrame: expect.any(Function) as unknown });
  });

  it('never uses the stub in a release build, even for the marker', async () => {
    vi.stubEnv('DEV', false);
    expect(await createCodeFrameSource(stubSource)).toBe(sandboxSource);
  });
});
