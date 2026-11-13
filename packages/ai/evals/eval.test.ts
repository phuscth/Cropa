import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BACKGROUND_EXAMPLES, MAX_BACKGROUND_SOURCE_BYTES } from '../src/tasks/background.ts';
import type { BackgroundInput } from '../src/tasks/background.ts';
import type { Transport } from '../src/transport.ts';
import { TurnError, scrubStderr } from './agent-transport.ts';
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

  describe('hostile modules', () => {
    // Each one tries to get from the module to the checker's process, which would hold the
    // developer's environment, files and network. None may get there: the check reports an
    // error, and no body below ever sees what it asked for.
    const attempts: [string, string][] = [
      ['postMessage.constructor', "postMessage.constructor('return process')()"],
      ['the global object', "globalThis.constructor.constructor('return process')()"],
      ['Function', "Function('return process')()"],
      ['an arrow function', "(() => {}).constructor('return process')()"],
      ['a class', "(class {}).constructor('return process')()"],
      ['a canvas shim', "new OffscreenCanvas(1, 1).constructor.constructor('return process')()"],
      ['eval', "eval('process')"],
    ];

    for (const [name, expression] of attempts) {
      it(`cannot reach process through ${name}`, async () => {
        const body = `const reached = ${expression}; throw new Error('LEAK ' + typeof reached);`;
        const check = await checkModuleInNode(module2d(body), scene);
        expect(check.ok).toBe(false);
        expect(check.error?.message ?? '').not.toContain('LEAK');
        expect(check.error?.kind).toBe('module-error');
      });
    }

    it('cannot reach process through a THREE class', async () => {
      const source = `const meta = { durationMs: 2000 };
function back(ctx, t, scene) {
  const reached = THREE.Vector3.constructor('return process')();
  throw new Error('LEAK ' + typeof reached);
}`;
      const check = await checkModuleInNode(source, scene);
      expect(check.ok).toBe(false);
      expect(check.error?.message ?? '').not.toContain('LEAK');
    });

    it('has no process, require or module in scope', async () => {
      const body = `
        const names = ['process', 'require', 'module', 'Buffer'].filter((n) => typeof globalThis[n] !== 'undefined');
        throw new Error('SEEN ' + names.join(','));`;
      const check = await checkModuleInNode(module2d(body), scene);
      expect(check.error?.message).toContain('SEEN ');
      expect(check.error?.message).not.toMatch(/SEEN .+/);
    });

    describe('through a refused dynamic import', () => {
      let server: Server;
      let port = 0;
      let connections = 0;

      beforeAll(async () => {
        server = createServer((socket) => {
          connections++;
          socket.destroy();
        });
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        port = (server.address() as AddressInfo).port;
      });
      afterAll(() => {
        server.close();
      });

      // The handler receives the rejection reason and tries everything a host-realm object would
      // allow: its constructors to a Function that reads process, and its prototype chain up to
      // the Object.prototype it was made in, where a toJSON would reach the checker's own
      // serialisation. A reason made inside the context passes every in-context identity check
      // below; a host error fails them, with or without string compilation being blocked.
      const probe = `
        let reached = false;
        let settled = false;
        const climb = (e) => {
          settled = true;
          try {
            let root = e;
            while (Object.getPrototypeOf(root) !== null) root = Object.getPrototypeOf(root);
            if (root !== Object.prototype || !(e instanceof TypeError) || !(e instanceof Error)) reached = true;
            Object.defineProperty(root, 'toJSON', {
              configurable: true,
              value() {
                if (this.ok === undefined) return this;
                const forged = Object.create(null);
                Object.assign(forged, { ok: false, error: { kind: 'timeout', message: 'FORGED' }, loops: true, maxFrameMs: 0 });
                return forged;
              },
            });
          } catch {}
          try {
            const p = e.constructor.constructor('return process')();
            reached = true;
            p.getBuiltinModule('net').connect(__PORT__, '127.0.0.1');
          } catch {}
          try {
            if (e.constructor.constructor('return 1')() === 1) reached = true;
          } catch {}
        };`;
      const attempt = (specifier: string, where: 'top' | 'back'): string => {
        const call = `void import('${specifier}').catch(climb);`;
        return `${probe.replace('__PORT__', String(port))}
          let frames = 0;
          const meta = { durationMs: 2000 };
          ${where === 'top' ? call : ''}
          function back(ctx, t, scene) {
            ${where === 'back' ? call : ''}
            if (!settled && ++frames > 8) throw new Error('UNSETTLED');
            if (reached) throw new Error('LEAK');
            ctx.fillRect(0, 0, 1, 1);
          }`;
      };

      for (const specifier of ['node:fs', 'x']) {
        for (const where of ['top', 'back'] as const) {
          it(`gives import('${specifier}') at the ${where} no host object`, async () => {
            const before = connections;
            const check = await checkModuleInNode(attempt(specifier, where), scene);
            await new Promise((done) => setTimeout(done, 200));
            expect(check.error?.message ?? '').not.toMatch(/LEAK|UNSETTLED|FORGED/);
            expect(check).toMatchObject({ ok: true, loops: true });
            expect(connections).toBe(before);
          });
        }
      }
    });

    it('cannot compile a string through any function it can reach', async () => {
      const body = `
        let compiled = false;
        for (const f of [Function, postMessage, (() => {}), Object.getPrototypeOf(async () => {}).constructor]) {
          try { if (f.constructor('return 1')() === 1) compiled = true; } catch {}
          try { if (f('return 1')() === 1) compiled = true; } catch {}
        }
        if (compiled) throw new Error('LEAK');`;
      const check = await checkModuleInNode(module2d(body), scene);
      expect(check).toMatchObject({ ok: true });
    });

    it('cannot replace the frame driver to fake a loop', async () => {
      const source = `
        const driver = globalThis.__cropaDriver;
        const real = driver.frame;
        try { driver.frame = (id, t, sceneJson) => real(id, 0, sceneJson); } catch {}
        try { Object.defineProperty(driver, 'frame', { value: (id, t, sceneJson) => real(id, 0, sceneJson) }); } catch {}
        const meta = { durationMs: 2000 };
        function back(ctx, t, scene) { ctx.fillRect(t * 999, 0, 10, 10); }`;
      const check = await checkModuleInNode(source, scene);
      expect(!check.ok || !check.loops).toBe(true);
    });

    it('cannot answer a frame request from its own message listener', async () => {
      const source = `
        addEventListener('message', (event) => {
          const { id, scene } = event.data;
          postMessage({ type: 'frame', id, back: { width: scene.width, height: scene.height, ops: [] }, front: null });
        });
        const meta = { durationMs: 2000 };
        function back(ctx, t) { ctx.fillRect(t * 999, 0, 1, 1); }`;
      const check = await checkModuleInNode(source, scene);
      expect(!check.ok || !check.loops).toBe(true);
    });

    it('survives a module that deletes the frame driver', async () => {
      const source = `
        try { delete globalThis.__cropaDriver; } catch {}
        try { globalThis.__cropaDriver = undefined; } catch {}
        const meta = { durationMs: 2000 };
        function back(ctx, t, scene) { ctx.fillRect(t * 999, 0, 10, 10); }`;
      const check = await checkModuleInNode(source, scene);
      expect(!check.ok || !check.loops).toBe(true);
      if (!check.ok) expect(check.error?.kind).toBe('module-error');
    });

    it('ends a thrown value whose toString never returns, at load and in a frame', async () => {
      const limits = { loadTimeoutMs: 200, frameTimeoutMs: 100 };
      const hang = '{ toString() { while (true) {} }, get message() { while (true) {} } }';
      const started = performance.now();
      const load = await checkModuleInNode(`const meta = { durationMs: 2000 };
throw ${hang};`, scene, limits);
      expect(load.ok).toBe(false);
      const frame = await checkModuleInNode(module2d(`throw ${hang};`), scene, limits);
      expect(frame.ok).toBe(false);
      expect(performance.now() - started).toBeLessThan(10_000);
    });
  });

  it('counts a promise callback the module queues against the frame time', async () => {
    const limits = { loadTimeoutMs: 200, frameTimeoutMs: 100 };
    const check = await checkModuleInNode(
      module2d('if (t === 1) Promise.resolve().then(() => { const s = Date.now(); while (Date.now() - s < 2000) {} });'),
      scene,
      limits,
    );
    expect(check).toMatchObject({ ok: false, error: { kind: 'timeout' } });
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
    const { report, records } = await runEval({
      task: entry.task,
      cases: loadCases(entry.cases, 'background'),
      transport: entry.mock(),
      provider: { name: 'mock', capabilities: [] },
      validate: entry.validate,
    });
    expect(report).toMatchObject({ cases: 30, validFirstTry: 23, validAfterRetry: 30, notices: {}, failing: [] });
    expect(records).toHaveLength(30);
    records.forEach((record, index) => {
      expect(record.passed).toBe(true);
      if (index % 4 !== 3) {
        expect(record.attempts).toHaveLength(1);
        expect(record.attempts[0]).not.toHaveProperty('output');
        return;
      }
      const [first, second] = record.attempts;
      expect(record.attempts).toHaveLength(2);
      expect(first?.check).toMatchObject({ ok: false, ran: true, loops: false });
      expect((first?.output as { source: string }).source).toContain('t * 1.5 * scene.width');
      expect(record.retryNote).toMatch(/loop/i);
      expect(second?.check?.ok).toBe(true);
      expect(second).not.toHaveProperty('output');
    });
    expect(report.validation).toMatchObject({
      runnableFirstTry: 23,
      runnableAfterRetry: 30,
      loopClosedFirstTry: 23,
      loopClosedAfterRetry: 30,
    });
    expect(report.validation?.maxFrameMs).toBeGreaterThan(0);
    expect(report.validation?.p95FrameMs).toBeGreaterThan(0);
  });

  it('names the failing case and keeps the transport error and its stderr in the record', async () => {
    const palette = EVAL_TASKS['palette-name'];
    if (!palette) throw new Error('no palette-name eval');
    const inner = palette.mock();
    let calls = 0;
    const transport: Transport = {
      run(req, opts) {
        calls++;
        if (calls === 2) {
          return Promise.reject(new TurnError('Protocol', 'the turn produced no result', 'last words of the CLI'));
        }
        return inner.run(req, opts);
      },
    };
    const cases = loadCases(palette.cases, 'palette-name').slice(0, 3);
    const { report, records } = await runEval({
      task: palette.task,
      cases,
      transport,
      provider: { name: 'mock', capabilities: [] },
    });
    const failed = cases[1]?.id;
    expect(report.failing).toEqual([failed]);
    expect(records.map((r) => r.passed)).toEqual([true, false, true]);
    const record = records[1];
    expect(record).toMatchObject({
      id: failed,
      passed: false,
      notice: { kind: 'Protocol' },
      attempts: [
        {
          attempt: 1,
          error: { kind: 'Protocol', message: 'the turn produced no result' },
          stderrTail: 'last words of the CLI',
        },
      ],
    });
  });
});

describe('scrubStderr', () => {
  const home = 'C:\\Users\\tester';

  it('turns the home folder into ~ in every spelling, including inside JSON', () => {
    const text = 'C:\\Users\\tester\\a c:/users/tester/b {"cwd":"C:\\\\Users\\\\tester\\\\c"}';
    expect(scrubStderr(text, home)).toBe('~\\a ~/b {"cwd":"~\\\\c"}');
  });

  it('removes keys, bearer tokens, emails, secret-looking JSON values and long opaque runs', () => {
    const text = [
      'key sk-abcdef1234567890 here',
      'Authorization: Bearer abc.DEF-123_xyz=',
      'mail me@example.com',
      '{"refresh_token": "plain", "note": "kept"}',
      `blob ${'A1b2'.repeat(10)}`,
    ].join('\n');
    const out = scrubStderr(text, home);
    for (const gone of ['sk-abcdef', 'abc.DEF', 'me@example.com', 'plain', 'A1b2A1b2']) {
      expect(out).not.toContain(gone);
    }
    expect(out).toContain('"note"');
    expect(out).toContain('kept');
  });

  it('keeps the last 4000 characters', () => {
    const out = scrubStderr(`${'a '.repeat(5000)}END`, home);
    expect(out).toHaveLength(4000);
    expect(out.endsWith('END')).toBe(true);
  });
});

describe('background refine eval on the mock provider', { timeout: 60_000 }, () => {
  const entry = EVAL_TASKS['background-refine'];

  it('refines a module that is already there, and every answer runs and loops', async () => {
    if (!entry?.validate) throw new Error('the refine eval has no validator');
    const cases = loadCases(entry.cases, 'background');
    expect(cases).toHaveLength(3);
    for (const c of cases) {
      expect((c.input as BackgroundInput).currentSource).toMatch(/function back\(/);
    }
    const { report } = await runEval({
      task: entry.task,
      cases,
      transport: entry.mock(),
      provider: { name: 'mock', capabilities: [] },
      validate: entry.validate,
    });
    expect(report).toMatchObject({ cases: 3, validAfterRetry: 3, notices: {} });
    expect(report.validation).toMatchObject({ runnableAfterRetry: 3, loopClosedAfterRetry: 3 });
  });
});
