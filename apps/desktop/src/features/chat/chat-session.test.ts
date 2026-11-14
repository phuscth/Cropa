import { backgroundTask, type TaskEvent, type TaskResult } from '@cropa/ai';
import { builtinPresets, defaultScene, type BackgroundSpec } from '@cropa/core';
import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage_Serialize } from '../../lib/bindings.ts';
import { historyReducer, initHistory, type HistoryAction } from '../editor/history.ts';
import { setBackgroundBlur } from '../editor/scene-edits.ts';
import { codeSourceOf } from './ai-background.ts';
import { createChatSaver, withValidBackgrounds } from './chat-store.ts';
import {
  createChatSession,
  descriptionFor,
  durationParts,
  isRefining,
  reachedCanvas,
  type AiRunRequest,
  type ChatMessage,
  type SendContext,
} from './chat-session.ts';

const preset = builtinPresets[0];
if (!preset) throw new Error('no built-in preset');

const withCode = (source = 'const meta = { durationMs: 4000 };') =>
  backgroundTask.postprocess({ source, durationMs: 4000, threeD: false }, {
    input: { description: 'x', palette: [], frame: { width: 1, height: 1, frame: { x: 0, y: 0, width: 1, height: 1, radius: 0, border: 0 } } },
  });

describe('chat session', () => {
  const other = builtinPresets[1]?.background ?? preset.background;
  const srcA = 'const meta = { durationMs: 4001 };';
  const srcB = 'const meta = { durationMs: 4002 };';
  const done = (result: BackgroundSpec): TaskResult<BackgroundSpec> => ({ result, source: 'ai' });
  const failed = (kind: 'Timeout' | 'Cancelled'): TaskResult<BackgroundSpec> => ({
    result: other,
    source: 'fallback',
    notice: { kind },
  });
  const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const ctx: SendContext = { palette: [], provider: 'mock', model: null, effort: 'medium' };

  const plain = preset.background;
  function setup(background: BackgroundSpec = plain, historyId: string | null = '1700000000000') {
    let h = initHistory({ ...defaultScene({ width: 400, height: 300 }), background });
    const dispatch = (action: HistoryAction) => { h = historyReducer(h, action); };
    const requests: AiRunRequest[] = [];
    const resolvers: ((out: TaskResult<BackgroundSpec>) => void)[] = [];
    let latest = 0;
    let ids = 0;
    let clock = 1000;
    const applied = vi.fn();
    const save = vi.fn<(id: string, messages: readonly ChatMessage[]) => void>();
    const session = createChatSession({
      start: (request) => {
        requests.push(request);
        return {
          fallback: other,
          done: new Promise((resolve) => { resolvers.push(resolve); }),
          noWebgl: () => false,
        };
      },
      history: {
        scene: () => h.present,
        preview: (change) => { dispatch({ type: 'preview', scene: (s) => change(s) }); },
        commit: () => { dispatch({ type: 'commit' }); },
      },
      beginBackgroundChange: () => {
        const mine = ++latest;
        return () => mine === latest;
      },
      onApplied: applied,
      save,
      newId: () => `m${String(++ids)}`,
      now: () => (clock += 500),
    });
    session.load(historyId, []);
    return {
      session,
      applied,
      save,
      requests,
      history: () => h,
      dispatch,
      messages: () => session.getState().messages,
      /** Answers the newest run. */
      answer: async (out: TaskResult<BackgroundSpec>) => {
        resolvers.at(-1)?.(out);
        await flush();
      },
      event: (event: TaskEvent) => { requests.at(-1)?.onEvent(event); },
      transport: (type: string, text?: string) => {
        requests.at(-1)?.onEvent({ type: 'transport', event: text === undefined ? { type } : { type, text } });
      },
    };
  }

  const send = (s: ReturnType<typeof setup>, text = 'rain') => { s.session.send(text, ctx); };

  it('moves from starting to writing to checking, and streams thinking, prose and the answer', () => {
    const s = setup();
    send(s);
    expect(s.session.getState().run).toMatchObject({ kind: 'generate', stage: 'started', prompt: 'rain', startedAt: 1500 });
    expect(s.requests[0]?.input.currentSource).toBeUndefined();
    // The closest preset shows while the AI works.
    expect(s.history().present.background).toBe(other);

    s.event({ type: 'attempt', attempt: 1 });
    s.transport('started');
    s.transport('thinking', 'Picking ');
    s.transport('thinking', 'colours.');
    s.transport('delta', 'Here it comes.');
    s.transport('output', '{"source":"co');
    s.transport('output', 'nst');
    expect(s.session.getState().run).toMatchObject({
      stage: 'writing',
      thinking: 'Picking colours.',
      text: 'Here it comes.',
      output: '{"source":"const',
    });

    s.event({ type: 'validating', attempt: 1 });
    expect(s.session.getState().run?.stage).toBe('checking');
  });

  it('shows a retry as retrying, keeps what was thought, and starts the answer over', () => {
    const s = setup();
    send(s);
    s.event({ type: 'attempt', attempt: 1 });
    s.transport('thinking', 'first');
    s.transport('output', '{"source":"a');
    s.event({ type: 'validating', attempt: 1 });
    s.event({ type: 'attempt', attempt: 2 });
    expect(s.session.getState().run).toMatchObject({ stage: 'retrying', attempt: 2, thinking: 'first\n\n', output: '' });
    s.transport('started');
    s.transport('thinking', 'second');
    expect(s.session.getState().run).toMatchObject({ stage: 'retrying', thinking: 'first\n\nsecond' });
  });

  it('appends the question and the reply once the run ends, and saves the conversation once', async () => {
    const s = setup();
    send(s);
    s.event({ type: 'attempt', attempt: 1 });
    s.transport('thinking', 'Picking colours.');
    await s.answer(done(withCode(srcA)));

    const [user, agent] = s.messages();
    expect(user).toMatchObject({ id: 'm1', role: 'user', text: 'rain', mode: 'generate' });
    expect(agent).toMatchObject({
      id: 'm2',
      role: 'agent',
      text: '',
      provider: 'mock',
      effort: 'medium',
      thinking: 'Picking colours.',
      outcome: 'applied',
    });
    expect(codeSourceOf(agent?.background as BackgroundSpec)).toBe(srcA);
    expect(s.session.getState()).toMatchObject({ run: null, startedOverFrom: null });
    expect(codeSourceOf(s.history().present.background)).toBe(srcA);
    expect(s.save).toHaveBeenCalledTimes(1);
    expect(s.save).toHaveBeenCalledWith('1700000000000', s.messages());
  });

  it('sends each message with the provider and model it was given, and stores them in the reply', async () => {
    const s = setup();
    s.session.send('rain', { ...ctx, provider: 'codex', model: 'gpt-6.1-sol' });
    expect(s.requests[0]).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol' });
    expect(s.session.getState().run).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol' });
    await s.answer(done(withCode(srcA)));
    expect(s.messages().at(-1)).toMatchObject({ role: 'agent', provider: 'codex', model: 'gpt-6.1-sol' });

    // A later message goes to whatever is chosen then, and no model means the CLI's default.
    s.session.send('more wind', { ...ctx, provider: 'claude', model: null });
    expect(s.requests[1]).toMatchObject({ provider: 'claude', model: null });
    await s.answer(done(withCode(srcB)));
    const reply = s.messages().at(-1);
    expect(reply).toMatchObject({ role: 'agent', provider: 'claude' });
    expect(reply).not.toHaveProperty('model');
  });

  it('keeps nothing on disk when the capture has no history id', async () => {
    const s = setup(plain, null);
    send(s);
    await s.answer(done(withCode(srcA)));
    expect(s.messages()).toHaveLength(2);
    expect(s.save).not.toHaveBeenCalled();
  });

  it('cuts what it stores to the limits Rust enforces', async () => {
    const s = setup();
    send(s, 'x'.repeat(3000));
    s.transport('delta', 'é'.repeat(20_000));
    s.transport('thinking', 'é'.repeat(20_000));
    const huge: BackgroundSpec = { ...plain, layers: [{ type: 'code', source: 'a'.repeat(90_000), durationMs: 4000, threeD: false }] };
    await s.answer(done(huge));
    const [user, agent] = s.messages();
    expect(Array.from(user?.text ?? '')).toHaveLength(2000);
    expect(new TextEncoder().encode(agent?.text).length).toBeLessThanOrEqual(16 * 1024);
    expect(new TextEncoder().encode(agent?.thinking ?? '').length).toBeLessThanOrEqual(16 * 1024);
    // A background over 80 KiB would make Rust refuse the whole conversation.
    expect(agent?.background).toBeUndefined();
    expect(agent?.outcome).toBe('applied');
  });

  it('announces an applied result once, and nothing for a fallback or a result dropped after an edit', async () => {
    const s = setup();
    send(s);
    await s.answer(done(withCode(srcA)));
    expect(s.applied).toHaveBeenCalledTimes(1);

    s.session.regenerate(ctx);
    await s.answer(failed('Timeout'));
    expect(s.applied).toHaveBeenCalledTimes(1);

    s.session.regenerate(ctx);
    s.dispatch({ type: 'preview', scene: (scene) => ({ ...scene, background: plain }) });
    await s.answer(done(withCode(srcB)));
    expect(s.applied).toHaveBeenCalledTimes(1);
  });

  it('regenerates from the last description as a fresh background and keeps the result on screen meanwhile', async () => {
    const s = setup();
    send(s, 'rain');
    await s.answer(done(withCode(srcA)));
    const shown = s.history().present.background;

    s.session.regenerate({ ...ctx, effort: 'high' });
    expect(s.requests[1]?.input).toMatchObject({ description: 'rain' });
    expect(s.requests[1]?.input.currentSource).toBeUndefined();
    expect(s.session.getState().run).toMatchObject({ kind: 'regenerate', prompt: 'rain', effort: 'high' });
    expect(s.history().present.background).toBe(shown);
    await s.answer(failed('Timeout'));
    expect(s.history().present.background).toBe(shown);
    const reply = s.messages().at(-1);
    expect(reply).toMatchObject({ role: 'agent', outcome: 'failed', error: 'Timeout', unchanged: true });
    expect(s.messages().at(-2)).toMatchObject({ role: 'user', mode: 'regenerate', text: 'rain' });
  });

  it('regenerates what is on the canvas, not a later request that failed or was stopped', async () => {
    const s = setup();
    send(s, 'rain');
    await s.answer(done(withCode(srcA)));
    send(s, 'snow');
    await s.answer(failed('Timeout'));
    s.session.regenerate(ctx);
    expect(s.requests[2]?.input).toMatchObject({ description: 'rain' });
    await s.answer(failed('Cancelled'));
    s.session.regenerate(ctx);
    expect(s.requests[3]?.input).toMatchObject({ description: 'rain' });
  });

  it('regenerates the description, not a change, after a refinement', async () => {
    const s = setup();
    send(s, 'fireflies');
    await s.answer(done(withCode(srcA)));
    send(s, 'make it night');
    await s.answer(done(withCode(srcB)));
    s.session.regenerate(ctx);
    expect(s.requests[2]?.input).toMatchObject({ description: 'fireflies' });
  });

  it('records a stop as a cancelled reply and leaves the canvas as it was', async () => {
    const s = setup();
    send(s);
    await s.answer(done(withCode(srcA)));
    const shown = s.history().present.background;
    s.session.regenerate(ctx);
    s.session.cancel();
    await s.answer(failed('Cancelled'));
    expect(s.history().present.background).toBe(shown);
    expect(s.messages().at(-1)).toMatchObject({ outcome: 'cancelled', unchanged: true });
    expect(s.messages().at(-1)?.error).toBeUndefined();
    expect(s.session.getState().run).toBeNull();
  });

  it('does nothing to regenerate or send without something to work from, or while a run is going', () => {
    const s = setup();
    s.session.regenerate(ctx);
    s.session.send('   ', ctx);
    expect(s.requests).toHaveLength(0);
    send(s);
    send(s, 'again');
    expect(s.requests).toHaveLength(1);
  });

  it('refines the scene code, keeps its other layers, and sends the current source', async () => {
    const start: BackgroundSpec = {
      ...preset.background,
      layers: [{ type: 'solid', color: '#abcdef' }, ...withCode(srcA).layers],
    };
    const s = setup(start);
    send(s, '  more wind ');
    expect(s.requests[0]?.input).toMatchObject({ description: 'more wind', currentSource: srcA });
    expect(s.session.getState().run?.kind).toBe('refine');
    expect(s.history().present.background).toBe(start);

    await s.answer(done(withCode(srcB)));
    const applied = s.history().present.background;
    expect(applied.layers).toHaveLength(start.layers.length);
    expect(applied.layers[0]).toEqual({ type: 'solid', color: '#abcdef' });
    expect(codeSourceOf(applied)).toBe(srcB);
    expect(s.messages()[0]).toMatchObject({ mode: 'refine', text: 'more wind' });
  });

  it('starts over to a fresh description, and a new result or another module brings the refine view back', async () => {
    const s = setup();
    const refining = () => isRefining(s.session.getState(), s.history().present);
    send(s);
    await s.answer(done(withCode(srcA)));
    expect(refining()).toBe(true);
    s.session.startOver();
    expect(refining()).toBe(false);
    send(s, 'snow');
    expect(s.requests[1]?.input.currentSource).toBeUndefined();
    expect(s.session.getState().run?.kind).toBe('generate');
    await s.answer(done(withCode(srcB)));
    expect(refining()).toBe(true);

    // Starting over from B and then undoing to A shows A for refining.
    s.session.startOver();
    expect(refining()).toBe(false);
    s.dispatch({ type: 'undo' });
    expect(codeSourceOf(s.history().present.background)).toBe(srcA);
    expect(refining()).toBe(true);
  });

  it('leaves the canvas alone when the background was edited meanwhile, and keeps the result to use later', async () => {
    const s = setup();
    send(s);
    s.dispatch({ type: 'edit', scene: (scene) => setBackgroundBlur(scene, 12) });
    const edited = s.history().present.background;
    await s.answer(done(withCode(srcA)));
    expect(s.history().present.background).toBe(edited);
    const { past, present } = s.history();
    expect([...past, present].some((scene) => codeSourceOf(scene.background) !== undefined)).toBe(false);

    const reply = s.messages().at(-1);
    expect(reply).toMatchObject({ outcome: 'applied', unchanged: true });
    expect(reachedCanvas(reply as ChatMessage)).toBe(false);
    s.session.useResult(reply?.id ?? '');
    expect(codeSourceOf(s.history().present.background)).toBe(srcA);
  });

  it('keeps the preset that stayed on screen after a failure as a normal undo step', async () => {
    const s = setup();
    send(s);
    await s.answer(failed('Timeout'));
    expect(s.history().present.background).toBe(other);
    expect(s.history().base).toBeNull();
    expect(s.history().past.map((scene) => scene.background)).toEqual([preset.background]);
    expect(s.messages().at(-1)).toMatchObject({ outcome: 'failed', error: 'Timeout', unchanged: false });
  });

  it('makes one undo step per result, and one per use of a past result', async () => {
    const s = setup();
    send(s);
    await s.answer(done(withCode(srcA)));
    // The preset shown while waiting is not a step of its own.
    expect(s.history().past.map((scene) => scene.background)).toEqual([preset.background]);
    send(s, 'again');
    await s.answer(done(withCode(srcB)));
    expect(s.history().past).toHaveLength(2);

    const source = () => codeSourceOf(s.history().present.background);
    expect(source()).toBe(srcB);
    s.dispatch({ type: 'undo' });
    expect(source()).toBe(srcA);
    s.dispatch({ type: 'undo' });
    expect(s.history().present.background).toEqual(preset.background);
    s.dispatch({ type: 'redo' });
    s.dispatch({ type: 'redo' });
    expect(source()).toBe(srcB);

    const firstReply = s.messages()[1];
    s.session.useResult(firstReply?.id ?? '');
    expect(source()).toBe(srcA);
    expect(s.history().past).toHaveLength(3);
    s.dispatch({ type: 'undo' });
    expect(source()).toBe(srcB);
    // The reply that is on the canvas has nothing to put back.
    const before = s.history().past.length;
    s.session.useResult(s.messages()[3]?.id ?? '');
    expect(s.history().past).toHaveLength(before);
  });

  it('shows another capture\'s conversation, and a run cancelled by it is not recorded', async () => {
    const s = setup();
    send(s);
    s.session.load('1700000000001', []);
    expect(s.session.getState()).toMatchObject({ run: null, messages: [] });
    await s.answer(done(withCode(srcA)));
    expect(s.messages()).toHaveLength(0);
    expect(s.save).not.toHaveBeenCalled();

    send(s, 'fog');
    s.session.dispose();
    await s.answer(failed('Cancelled'));
    expect(s.messages()).toHaveLength(0);

    const kept: ChatMessage[] = [{ id: 'k1', role: 'user', at: 1, text: 'old', mode: 'generate' }];
    s.session.load('1700000000002', kept);
    send(s, 'mist');
    await s.answer(failed('Timeout'));
    expect(s.save).toHaveBeenCalledWith('1700000000002', s.messages());
    expect(s.messages()).toHaveLength(3);
  });

  it('describes a reply by the newest whole description before it', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', at: 1, text: 'fireflies', mode: 'generate' },
      { id: '2', role: 'agent', at: 2, text: '', outcome: 'applied' },
      { id: '3', role: 'user', at: 3, text: 'make it night', mode: 'refine' },
      { id: '4', role: 'agent', at: 4, text: '', outcome: 'applied' },
    ];
    expect(descriptionFor(messages, 3)).toBe('fireflies');
    expect(descriptionFor(messages.slice(2), 1)).toBe('make it night');
  });
});

describe('duration parts', () => {
  it('floors to whole seconds and splits minutes', () => {
    expect(durationParts(0)).toEqual({ minutes: 0, seconds: 0 });
    expect(durationParts(59_999)).toEqual({ minutes: 0, seconds: 59 });
    expect(durationParts(60_000)).toEqual({ minutes: 1, seconds: 0 });
    expect(durationParts(218_000)).toEqual({ minutes: 3, seconds: 38 });
    expect(durationParts(-5000)).toEqual({ minutes: 0, seconds: 0 });
  });
});

describe('loaded messages', () => {
  it('lose only a background that fails the schema', () => {
    const valid = withCode('const meta = { durationMs: 4000 };');
    const stored: ChatMessage_Serialize[] = [
      { id: 'a', role: 'agent', at: 1, text: 'ok', provider: 'claude', outcome: 'applied', background: valid },
      { id: 'b', role: 'agent', at: 2, text: 'kept text', provider: 'claude', outcome: 'applied', background: { layers: 'nope' } },
      { id: 'c', role: 'user', at: 3, text: 'hi', mode: 'generate', background: null },
    ];
    const loaded = withValidBackgrounds(stored);
    expect(loaded[0]?.background).toEqual(valid);
    expect(loaded[1]).toMatchObject({ id: 'b', text: 'kept text', outcome: 'applied' });
    expect('background' in (loaded[1] ?? {})).toBe(false);
    expect('background' in (loaded[2] ?? {})).toBe(false);
  });
});

describe('chat saver', () => {
  const ok = { status: 'ok', data: true } as const;

  it('saves one conversation after the other and reports a failure through onError', async () => {
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const save = vi.fn((id: string) => {
      order.push(`start ${id}`);
      return new Promise<typeof ok>((resolve) => {
        releases.push(() => { order.push(`end ${id}`); resolve(ok); });
      });
    });
    const onError = vi.fn();
    const saver = createChatSaver({ onError, onNotKept: vi.fn() }, save);
    saver.save('1', []);
    saver.save('2', []);
    await flushPromises();
    expect(order).toEqual(['start 1']);
    releases[0]?.();
    await flushPromises();
    expect(order).toEqual(['start 1', 'end 1', 'start 2']);
    releases[1]?.();
    await flushPromises();
    expect(onError).not.toHaveBeenCalled();

    await saver.settled();

    const failing = createChatSaver({ onError, onNotKept: vi.fn() }, () => Promise.reject(new Error('disk')));
    failing.save('3', []);
    await failing.settled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('says so when the capture is gone and nothing was written', async () => {
    const onNotKept = vi.fn();
    const gone = createChatSaver({ onError: vi.fn(), onNotKept }, () => Promise.resolve({ status: 'ok', data: false }));
    gone.save('4', []);
    await gone.settled();
    expect(onNotKept).toHaveBeenCalledTimes(1);
  });
});

const flushPromises = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
