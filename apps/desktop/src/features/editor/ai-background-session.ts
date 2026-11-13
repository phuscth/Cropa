import type { AiErrorKind, BackgroundInput, TaskEvent, TaskResult } from '@cropa/ai';
import type { BackgroundSpec, PaletteColour, Scene } from '@cropa/core';

import type { AiEffort, AiProvider } from '../../lib/bindings.ts';
import type { CodeScene } from '../code-sandbox/index.ts';
import {
  backgroundRequest,
  backgroundWhileWaiting,
  codeSourceOf,
  replaceCodeLayer,
} from './ai-background.ts';
import { applyBackground, sameBackground } from './scene-edits.ts';
import type { SceneEdit } from './use-scene-history.ts';

export type RunKind = 'generate' | 'regenerate' | 'refine';

/** What the user asked for and who wrote it, kept for the code layer that came out of a run. */
export interface ResultInfo {
  description: string;
  provider: AiProvider;
  effort: AiEffort;
}

/** Why a run left the scene as it was, for the notice shown to the user. */
export interface AiRunNotice {
  reason: 'no-webgl' | AiErrorKind;
  provider: AiProvider;
  /** The background that was on screen before the run is still there. */
  unchanged: boolean;
}

export interface AiBackgroundState {
  run: { kind: RunKind; phase: 'writing' | 'checking'; startedAt: number } | null;
  /** Set after a failed run; cleared when a run starts or on dismiss. */
  notice: AiRunNotice | null;
  /** The module the user chose Start over from; a different module on screen is refined again. */
  startedOverFrom: string | null;
}

/** One run of the background task, as the session needs it. */
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

export interface AiBackgroundDeps {
  start: (request: AiRunRequest) => AiRunHandle;
  history: AiHistoryAccess;
  /** `beginBackgroundChange` of the editor: false once another change to the background began. */
  beginBackgroundChange: () => () => boolean;
  /** Called once a generated background has been applied to the scene. */
  onApplied?: () => void;
  now: () => number;
}

export interface AiBackgroundSession {
  subscribe: (listener: () => void) => () => void;
  getState: () => AiBackgroundState;
  /** What the scene's code layer was made from, when it was made in this editor session. */
  infoFor: (scene: Scene) => ResultInfo | undefined;
  generate: (description: string, palette: readonly PaletteColour[], provider: AiProvider, effort: AiEffort) => void;
  /** The same description again; does nothing when the scene's code layer has no known description. */
  regenerate: (palette: readonly PaletteColour[], provider: AiProvider, effort: AiEffort) => void;
  /** Changes the scene's code layer as asked; does nothing without a code layer. */
  refine: (change: string, palette: readonly PaletteColour[], provider: AiProvider, effort: AiEffort) => void;
  /** Points the session at the history of the current render. */
  attach: (history: AiHistoryAccess) => void;
  startOver: () => void;
  dismissNotice: () => void;
  cancel: () => void;
  /** Aborts a run in flight; the session stays usable. */
  dispose: () => void;
}

const IDLE: AiBackgroundState = { run: null, notice: null, startedOverFrom: null };

/** True when the scene's code layer is shown for refining rather than for a fresh description. */
export function isRefining(state: AiBackgroundState, scene: Scene): boolean {
  const source = codeSourceOf(scene.background);
  return source !== undefined && source !== state.startedOverFrom;
}

/**
 * The state of the AI background section: at most one run at a time, and one undo step per
 * applied result. While a run waits, the closest preset is a live change with no step of its
 * own; the result then closes it, so a single undo goes back to what was there before.
 */
export function createAiBackgroundSession(deps: AiBackgroundDeps): AiBackgroundSession {
  let history = deps.history;
  let state = IDLE;
  const listeners = new Set<() => void>();
  // Keyed by the module source, so undo and redo between results find the right details.
  const infos = new Map<string, ResultInfo>();
  let current: AbortController | undefined;

  const set = (next: Partial<AiBackgroundState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const infoFor = (scene: Scene): ResultInfo | undefined => {
    const source = codeSourceOf(scene.background);
    return source === undefined ? undefined : infos.get(source);
  };

  const begin = (
    kind: RunKind,
    request: { description: string; currentSource?: string },
    palette: readonly PaletteColour[],
    provider: AiProvider,
    effort: AiEffort,
  ) => {
    current?.abort();
    const abort = new AbortController();
    current = abort;
    const isCurrent = deps.beginBackgroundChange();
    const before = history.scene();
    const known = infoFor(before);

    const { input, check } = backgroundRequest(before, request.description, palette);
    const run = deps.start({
      input: request.currentSource === undefined ? input : { ...input, currentSource: request.currentSource },
      check,
      provider,
      effort,
      signal: abort.signal,
      onEvent: (event) => {
        if (abort.signal.aborted || !state.run) return;
        if (event.type === 'attempt') set({ run: { ...state.run, phase: 'writing' } });
        if (event.type === 'validating') set({ run: { ...state.run, phase: 'checking' } });
      },
    });
    set({ run: { kind, phase: 'writing', startedAt: deps.now() }, notice: null });

    // A refinement changes nothing on screen until it is done. Otherwise the closest preset shows
    // while the AI works, unless the scene already has generated code: that stays.
    const shown = kind === 'refine' ? before.background : backgroundWhileWaiting(before.background, run.fallback);
    const previewed = !sameBackground(before.background, shown);
    history.preview((s) => applyBackground(s, shown));

    void run.done.then((out) => {
      // A newer run took over, and with it the live change.
      if (current !== abort) return;
      current = undefined;
      set({ run: null });
      const untouched =
        !abort.signal.aborted && isCurrent() && sameBackground(history.scene().background, shown);

      if (out.source === 'ai') {
        // Another background was chosen meanwhile: leave the scene alone.
        if (!untouched) return;
        const applied = kind === 'refine' ? replaceCodeLayer(shown, out.result) : out.result;
        const source = codeSourceOf(applied);
        if (source !== undefined) {
          infos.set(source, {
            description: kind === 'generate' ? request.description : (known?.description ?? request.description),
            provider,
            effort,
          });
        }
        // Checked again inside the update, which sees the newest scene.
        history.preview((s) => (sameBackground(s.background, shown) ? applyBackground(s, applied) : s));
        history.commit();
        set({ startedOverFrom: null, notice: null });
        deps.onApplied?.();
        return;
      }

      // The preset that stays on screen becomes a normal undo step.
      if (previewed && sameBackground(history.scene().background, shown)) history.commit();
      if (abort.signal.aborted || !isCurrent() || out.notice?.kind === 'Cancelled') return;
      set({
        notice: {
          reason: run.noWebgl() ? 'no-webgl' : (out.notice?.kind ?? 'Protocol'),
          provider,
          unchanged: !previewed,
        },
      });
    });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getState: () => state,
    infoFor,
    generate(description, palette, provider, effort) {
      const text = description.trim();
      if (text === '') return;
      begin('generate', { description: text }, palette, provider, effort);
    },
    regenerate(palette, provider, effort) {
      const description = infoFor(history.scene())?.description;
      if (description === undefined) return;
      begin('regenerate', { description }, palette, provider, effort);
    },
    refine(change, palette, provider, effort) {
      const text = change.trim();
      const currentSource = codeSourceOf(history.scene().background);
      if (text === '' || currentSource === undefined) return;
      begin('refine', { description: text, currentSource }, palette, provider, effort);
    },
    attach(next) {
      history = next;
    },
    startOver() {
      set({ startedOverFrom: codeSourceOf(history.scene().background) ?? null });
    },
    dismissNotice() {
      set({ notice: null });
    },
    cancel() {
      current?.abort();
    },
    dispose() {
      current?.abort();
    },
  };
}
