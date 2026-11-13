import { describe, expect, it } from 'vitest';

import { BACKGROUND_EXAMPLES, MAX_BACKGROUND_SOURCE_BYTES } from '../src/tasks/background.ts';
import type { BackgroundInput } from '../src/tasks/background.ts';
import { runEval } from './eval.ts';
import { checkModuleInNode } from './node-check.ts';
import type { NodeScene } from './node-check.ts';
import { EVAL_TASKS, checkScene, loadCases } from './registry.ts';

const scene: NodeScene = {
  width: 640,
  height: 360,
  palette: ['#102030', '#aabbcc', '#ff8800'],
  frame: { x: 100, y: 60, width: 440, height: 240, radius: 12, border: 0 },
};

const module2d = (body: string): string => `const meta = { durationMs: 2000 };\nfunction back(ctx, t, scene) { ${body} }`;

describe('checkModuleInNode', { timeout: 30_000 }, () => {
  it('runs every example module, and each one loops', async () => {
    for (const example of BACKGROUND_EXAMPLES) {
      const check = await checkModuleInNode(example.source, scene);
      expect(check, example.name).toMatchObject({ ok: true, loops: true, durationMs: example.durationMs });
    }
  });

  it('reports a motion that is not periodic in t', async () => {
    const check = await checkModuleInNode(module2d('ctx.fillRect(t * 1.5 * scene.width, 0, 10, 10);'), scene);
    expect(check).toMatchObject({ ok: true, loops: false });
  });

  it('reports a non-seeded random draw as not looping', async () => {
    const check = await checkModuleInNode(module2d('ctx.fillRect(Math.random() * 100, 0, 5, 5);'), scene);
    expect(check.loops).toBe(false);
  });

  it('treats an hsl hue of 360 at t=1 as the same colour as 0 at t=0', async () => {
    const check = await checkModuleInNode(
      module2d("ctx.fillStyle = 'hsl(' + t * 360 + ' 80% 50%)'; ctx.fillRect(0, 0, scene.width, scene.height);"),
      scene,
    );
    expect(check.loops).toBe(true);
  });

  it('sees a three.js object that does not come back to where it started', async () => {
    const example = BACKGROUND_EXAMPLES.find((e) => e.threeD);
    const source = example?.source.replace('2 * Math.PI * t', '1.5 * Math.PI * t') ?? '';
    expect(source).not.toBe(example?.source);
    expect(await checkModuleInNode(source, scene)).toMatchObject({ ok: true, loops: false });
  });

  it('reports the errors the sandbox reports', async () => {
    expect(await checkModuleInNode(module2d('missing.call();'), scene)).toMatchObject({
      ok: false,
      error: { kind: 'module-error', message: expect.stringContaining('missing is not defined') as unknown },
    });
    expect(await checkModuleInNode('const meta = {', scene)).toMatchObject({
      ok: false,
      error: { kind: 'module-error' },
    });
    expect(await checkModuleInNode('function back() {}', scene)).toMatchObject({
      ok: false,
      error: { kind: 'module-error', message: expect.stringContaining('meta') as unknown },
    });
    expect(await checkModuleInNode(`// ${'x'.repeat(MAX_BACKGROUND_SOURCE_BYTES)}`, scene)).toMatchObject({
      ok: false,
      error: { kind: 'source-too-large' },
    });
  });

  it('keeps model code away from the machine even when it reaches the host process', async () => {
    process.env['CROPA_ESCAPE_TEST_SECRET'] = 'secret';
    try {
      // postMessage.constructor is the host Function, so this reaches the checker's own `process`.
      const report = `
        const p = postMessage.constructor('return process')();
        const attempt = (f) => { try { f(); return 'allowed'; } catch (e) { return String(e.code ?? e.message); } };
        throw new Error(JSON.stringify({
          env: Object.keys(p.env),
          spawn: attempt(() => p.getBuiltinModule('child_process').execFileSync('node', ['-v'])),
          write: attempt(() => p.getBuiltinModule('fs').writeFileSync('escape.txt', 'x')),
          worker: attempt(() => new (p.getBuiltinModule('worker_threads').Worker)('1', { eval: true })),
        }));`;
      const check = await checkModuleInNode(module2d(report), scene);
      const seen = JSON.parse((check.error?.message ?? '').replace(/^Error: /, '')) as {
        env: string[];
        spawn: string;
        write: string;
        worker: string;
      };
      expect(seen.env).not.toContain('CROPA_ESCAPE_TEST_SECRET');
      expect(seen.spawn).toBe('ERR_ACCESS_DENIED');
      expect(seen.write).toBe('ERR_ACCESS_DENIED');
      expect(seen.worker).toBe('ERR_ACCESS_DENIED');
    } finally {
      delete process.env['CROPA_ESCAPE_TEST_SECRET'];
    }
  });

  it('stops a module that never returns, at load and in a frame', async () => {
    const limits = { loadTimeoutMs: 150, frameTimeoutMs: 100 };
    const load = await checkModuleInNode('const meta = { durationMs: 2000 };\nwhile (true) {}', scene, limits);
    expect(load).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    const frame = await checkModuleInNode(module2d('while (true) {}'), scene, limits);
    expect(frame).toMatchObject({
      ok: false,
      error: { kind: 'timeout', message: expect.stringContaining('took longer than 150 ms') as unknown },
    });
  });
});

describe('checkScene', () => {
  const input = (width: number, height: number): BackgroundInput => ({
    description: 'x',
    palette: [{ hex: '#112233', weight: 1 }],
    frame: { width, height, frame: { x: width / 4, y: height / 4, width: width / 2, height: height / 2, radius: 20, border: 4 } },
  });

  it('keeps a canvas that fits and shrinks one that does not to 1920 on the long side', () => {
    expect(checkScene(input(1600, 1000))).toMatchObject({ width: 1600, height: 1000, palette: ['#112233'] });
    expect(checkScene(input(3840, 2160))).toMatchObject({
      width: 1920,
      height: 1080,
      frame: { x: 480, y: 270, width: 960, height: 540, radius: 10, border: 2 },
    });
  });
});

describe('background eval on the mock provider', { timeout: 60_000 }, () => {
  const entry = EVAL_TASKS['background'];

  it('has 30 cases with distinct ids', () => {
    const cases = loadCases('cases/background.json', 'background');
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(30);
  });

  it('answers as scripted: every fourth case needs the retry, and the retry runs and loops', async () => {
    if (!entry?.validate) throw new Error('the background eval has no validator');
    const report = await runEval({
      task: entry.task,
      cases: loadCases(entry.cases, 'background'),
      transport: entry.mock(),
      provider: { name: 'mock', capabilities: [] },
      validate: entry.validate,
    });
    expect(report).toMatchObject({ cases: 30, validFirstTry: 23, validAfterRetry: 30, notices: {} });
    expect(report.validation).toMatchObject({
      runnableFirstTry: 23,
      runnableAfterRetry: 30,
      loopClosedFirstTry: 23,
      loopClosedAfterRetry: 30,
    });
    expect(report.validation?.maxFrameMs).toBeGreaterThan(0);
    expect(report.validation?.p95FrameMs).toBeGreaterThan(0);
  });
});
