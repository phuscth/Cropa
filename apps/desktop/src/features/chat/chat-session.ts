import type { BackgroundInput, TaskEvent, TaskResult } from '@cropa/ai';
import type { BackgroundSpec, PaletteColour, Scene } from '@cropa/core';

import type { AiEffort, AiProvider, ChatMessage_Deserialize, ChatOutcome } from '../../lib/bindings.ts';
import type { CodeScene } from '../code-sandbox/index.ts';
import { applyBackground, sameBackground } from '../editor/scene-edits.ts';
import type { SceneEdit } from '../editor/use-scene-history.ts';
import {
  backgroundRequest,
  backgroundWhileWaiting,
  codeSourceOf,
  replaceCodeLayer,
} from './ai-background.ts';

/** One bubble of the conversation, as it is kept on disk. */
export type ChatMessage = ChatMessage_Deserialize;

/** How a run ended, before it is written into the reply. */
interface Outcome {
  outcome: ChatOutcome;
  /** Why it failed: `no-webgl` or the kind of the task's notice. */
  error?: string;
  /** The background that was on screen before the run is still there. */
  unchanged?: boolean;
  background?: BackgroundSpec;
}

export type RunKind = 'generate' | 'regenerate' | 'refine';

/**
 * Where a reply in flight stands. `started`: asked, the CLI is starting. `writing`: the first
 * attempt is under way. `checking`: the answer runs in the sandbox. `retrying`: the first answer
 * failed a check and the second attempt is under way.
 */
export type ReplyStage = 'started' | 'writing' | 'checking' | 'retrying';

/** The reply being written: what the user asked and what has streamed in so far. */
export interface ChatRun {
  kind: RunKind;
  prompt: string;
  provider: AiProvider;
  effort: AiEffort;
  stage: ReplyStage;
  attempt: 1 | 2;
  startedAt: number;
  /** The reasoning summary the CLI shows, attempts separated by a blank line. */
  thinking: string;
  /** Reply prose. */
  text: string;
  /** The structured answer's JSON text so far, from the current attempt. */
  output: string;
}

export interface ChatState {
  messages: readonly ChatMessage[];
  run: ChatRun | null;
  /** The module the user chose Start over from; a different module on screen is refined again. */
  startedOverFrom: string | null;
}

/** What went into one run of the background task. */
export interface AiRunRequest {
  input: BackgroundInput;
  check: CodeScene;
  provider: AiProvider;
  effort: AiEffort;
  signal: AbortSignal;
  onEvent: (event: TaskEvent) => void;
}

export interface AiRunHandle {
  /** The closest preset, ready at once. */
  fallback: BackgroundSpec;
  done: Promise<TaskResult<BackgroundSpec>>;
  /** True once a check found that this window has no WebGL. */
  noWebgl: () => boolean;
}

/** What the session needs of the editor's undo history. */
export interface AiHistoryAccess {
  scene: () => Scene;
  preview: (change: SceneEdit) => void;
  commit: () => void;
}

export interface ChatDeps {
  start: (request: AiRunRequest) => AiRunHandle;
  history: AiHistoryAccess;
  /** `beginBackgroundChange` of the editor: false once another change to the background began. */
  beginBackgroundChange: () => () => boolean;
  /** Called once a background has been put on the canvas. */
  onApplied?: () => void;
  /** Keeps the conversation of a capture; called once per finished reply. */
  save: (historyId: string, messages: readonly ChatMessage[]) => void;
  newId: () => string;
  now: () => number;
}

/** What one request is made with. */
export interface SendContext {
  palette: readonly PaletteColour[];
  provider: AiProvider;
  effort: AiEffort;
}

export interface ChatSession {
  subscribe: (listener: () => void) => () => void;
  getState: () => ChatState;
  /** Asks for a background: a fresh one, or a change to the code on the canvas. */
  send: (text: string, context: SendContext) => void;
  /** The last description again, as a fresh background. Does nothing without an earlier one. */
  regenerate: (context: SendContext) => void;
  /** Puts the background of a past reply back on the canvas as one undo step. */
  useResult: (messageId: string) => void;
  /** Points the session at the history of the current render. */
  attach: (history: AiHistoryAccess) => void;
  /** The next message describes a new background instead of changing this one. */
  startOver: () => void;
  /** Stops the run in flight; the reply is kept as cancelled. */
  cancel: () => void;
  /** Shows the conversation of another capture. `historyId` is null when it is not kept. */
  load: (historyId: string | null, messages: readonly ChatMessage[]) => void;
  /** Aborts a run in flight without recording it; the session stays usable. */
  dispose: () => void;
}

/** The limits Rust puts on a stored message. */
const MAX_USER_TEXT_CHARS = 2000;
const MAX_AGENT_TEXT_BYTES = 16 * 1024;
const MAX_THINKING_BYTES = 16 * 1024;
const MAX_BACKGROUND_BYTES = 80 * 1024;

const encoder = new TextEncoder();

/** `text` cut to at most `max` bytes of UTF-8, on a whole character. */
function cutBytes(text: string, max: number): string {
  if (text.length * 3 <= max || encoder.encode(text).length <= max) return text;
  const cut = new TextDecoder().decode(encoder.encode(text).slice(0, max));
  return cut.replace(/�+$/, '');
}

/** The background a reply carries; the window checked it against the schema when it read it. */
export function messageBackground(message: ChatMessage): BackgroundSpec | undefined {
  const value = message.background;
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { layers?: unknown }).layers)) {
    return undefined;
  }
  return value as BackgroundSpec;
}

/** True when the scene's code layer is shown for refining rather than for a fresh description. */
export function isRefining(state: ChatState, scene: Scene): boolean {
  const source = codeSourceOf(scene.background);
  return source !== undefined && source !== state.startedOverFrom;
}

/**
 * The description a reply answers: the newest message that asked for a whole background, at or
 * before `index`. A change ("make it night") alone would make a poor name.
 */
export function descriptionFor(messages: readonly ChatMessage[], index: number): string {
  for (let i = Math.min(index, messages.length - 1); i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user' && message.mode !== 'refine') return message.text;
  }
  for (let i = Math.min(index, messages.length - 1); i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return message.text;
  }
  return '';
}

const IDLE: ChatState = { messages: [], run: null, startedOverFrom: null };

/**
 * The state of the AI chat: at most one run at a time, and one undo step per applied result.
 * While a run waits, the closest preset is a live change with no step of its own; the result
 * then closes it, so a single undo goes back to what was there before.
 *
 * A finished reply, and the message it answers, are appended to the conversation and handed to
 * `deps.save` when the conversation has a history id.
 */
export function createChatSession(deps: ChatDeps): ChatSession {
  let history = deps.history;
  let state = IDLE;
  let historyId: string | null = null;
  const listeners = new Set<() => void>();
  let current: AbortController | undefined;

  const set = (next: Partial<ChatState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const updateRun = (change: (run: ChatRun) => ChatRun) => {
    if (state.run) set({ run: change(state.run) });
  };

  const onTransport = (event: { type: string } & Record<string, unknown>) => {
    const text = typeof event['text'] === 'string' ? event['text'] : '';
    switch (event.type) {
      case 'started':
        updateRun((run) => (run.stage === 'started' ? { ...run, stage: run.attempt === 2 ? 'retrying' : 'writing' } : run));
        break;
      case 'thinking':
        updateRun((run) => ({ ...run, thinking: run.thinking + text }));
        break;
      case 'delta':
        updateRun((run) => ({ ...run, text: run.text + text }));
        break;
      case 'output':
        updateRun((run) => ({ ...run, output: run.output + text }));
        break;
    }
  };

  const onEvent = (abort: AbortController) => (event: TaskEvent) => {
    if (abort.signal.aborted || !state.run) return;
    if (event.type === 'attempt') {
      updateRun((run) => ({
        ...run,
        attempt: event.attempt,
        // A retry keeps what was thought and said, a blank line apart, and starts a new answer.
        stage: event.attempt === 2 ? 'retrying' : run.stage,
        thinking: event.attempt === 2 && run.thinking !== '' ? `${run.thinking}\n\n` : run.thinking,
        text: event.attempt === 2 && run.text !== '' ? `${run.text}\n\n` : run.text,
        output: '',
      }));
    } else if (event.type === 'validating') {
      updateRun((run) => ({ ...run, stage: 'checking' }));
    } else {
      onTransport(event.event);
    }
  };

  const begin = (
    kind: RunKind,
    prompt: string,
    currentSource: string | undefined,
    { palette, provider, effort }: SendContext,
  ) => {
    if (state.run) return;
    const abort = new AbortController();
    current = abort;
    const isCurrent = deps.beginBackgroundChange();
    const before = history.scene();
    const startedAt = deps.now();

    const { input, check } = backgroundRequest(before, prompt, palette);
    const handle = deps.start({
      input: currentSource === undefined ? input : { ...input, currentSource },
      check,
      provider,
      effort,
      signal: abort.signal,
      onEvent: onEvent(abort),
    });
    set({
      run: {
        kind,
        prompt,
        provider,
        effort,
        stage: 'started',
        attempt: 1,
        startedAt,
        thinking: '',
        text: '',
        output: '',
      },
    });

    // A refinement changes nothing on screen until it is done. Otherwise the closest preset shows
    // while the AI works, unless the scene already has generated code: that stays.
    const shown = kind === 'refine' ? before.background : backgroundWhileWaiting(before.background, handle.fallback);
    const previewed = !sameBackground(before.background, shown);
    history.preview((s) => applyBackground(s, shown));

    void handle.done.then((out) => {
      // The session was disposed, or loaded with another conversation: nothing to record.
      if (current !== abort) return;
      current = undefined;
      const run = state.run;
      const untouched =
        !abort.signal.aborted && isCurrent() && sameBackground(history.scene().background, shown);

      let reply: Outcome;
      if (out.source === 'ai') {
        const applied = kind === 'refine' ? replaceCodeLayer(shown, out.result) : out.result;
        if (untouched) {
          // Checked again inside the update, which sees the newest scene.
          history.preview((s) => (sameBackground(s.background, shown) ? applyBackground(s, applied) : s));
          history.commit();
        }
        // Another background chosen meanwhile keeps the canvas as it is; the result stays in the
        // conversation and can be put back from there.
        reply = { outcome: 'applied', background: applied };
      } else {
        // The preset that stays on screen becomes a normal undo step.
        if (previewed && sameBackground(history.scene().background, shown)) history.commit();
        const cancelled = abort.signal.aborted || out.notice?.kind === 'Cancelled';
        const error = handle.noWebgl() ? 'no-webgl' : (out.notice?.kind ?? 'Protocol');
        reply = cancelled
          ? { outcome: 'cancelled', unchanged: !previewed }
          : { outcome: 'failed', error, unchanged: !previewed };
      }
      finish(run, reply, untouched && out.source === 'ai');
    });
  };

  const finish = (
    run: ChatRun | null,
    reply: Outcome,
    applied: boolean,
  ) => {
    if (!run) return;
    const at = deps.now();
    const user: ChatMessage = {
      id: deps.newId(),
      role: 'user',
      at: run.startedAt,
      text: Array.from(run.prompt).slice(0, MAX_USER_TEXT_CHARS).join(''),
      mode: run.kind,
    };
    const thinking = cutBytes(run.thinking.trimEnd(), MAX_THINKING_BYTES);
    const agent: ChatMessage = {
      id: deps.newId(),
      role: 'agent',
      at,
      text: cutBytes(run.text.trimEnd(), MAX_AGENT_TEXT_BYTES),
      provider: run.provider,
      effort: run.effort,
      outcome: reply.outcome,
      elapsedMs: Math.max(0, Math.round(at - run.startedAt)),
      ...(thinking === '' ? {} : { thinking }),
      ...(reply.error === undefined ? {} : { error: reply.error }),
      ...(reply.unchanged === undefined ? {} : { unchanged: reply.unchanged }),
      ...(reply.background !== undefined &&
      encoder.encode(JSON.stringify(reply.background)).length <= MAX_BACKGROUND_BYTES
        ? { background: reply.background }
        : {}),
    };
    const messages = [...state.messages, user, agent];
    set({ run: null, ...(applied ? { startedOverFrom: null } : {}), messages });
    if (applied) deps.onApplied?.();
    if (historyId !== null) deps.save(historyId, messages);
  };

  const stop = () => {
    current?.abort();
    current = undefined;
  };

  const lastDescription = (): string | undefined => {
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const message = state.messages[i];
      if (message?.role === 'user' && message.mode !== 'refine') return message.text;
    }
    return undefined;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getState: () => state,
    send(text, context) {
      const prompt = text.trim();
      if (prompt === '' || state.run) return;
      const scene = history.scene();
      const source = codeSourceOf(scene.background);
      if (source !== undefined && isRefining(state, scene)) begin('refine', prompt, source, context);
      else begin('generate', prompt, undefined, context);
    },
    regenerate(context) {
      const description = lastDescription();
      if (description === undefined) return;
      begin('regenerate', description, undefined, context);
    },
    useResult(messageId) {
      if (state.run) return;
      const message = state.messages.find((candidate) => candidate.id === messageId);
      const next = message && messageBackground(message);
      if (!next) return;
      if (sameBackground(history.scene().background, next)) return;
      deps.beginBackgroundChange();
      history.preview((s) => applyBackground(s, next));
      history.commit();
      set({ startedOverFrom: null });
      deps.onApplied?.();
    },
    attach(next) {
      history = next;
    },
    startOver() {
      set({ startedOverFrom: codeSourceOf(history.scene().background) ?? null });
    },
    cancel() {
      current?.abort();
    },
    load(id, messages) {
      stop();
      historyId = id;
      state = { messages, run: null, startedOverFrom: null };
      for (const listener of listeners) listener();
    },
    dispose() {
      if (!current && !state.run) return;
      stop();
      set({ run: null });
    },
  };
}
