import { backgroundTask, runTask } from '@cropa/ai';
import type { PaletteColour } from '@cropa/core';
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type AiEffort, type AiProvider, type FavoriteModel } from '../../lib/bindings.ts';
import { type UserError } from '../../lib/errors.ts';
import { saveUserPreset } from '../../lib/user-presets.ts';
import { useAiAccess, type AiAccess } from '../ai/access.ts';
import { initialChoice, type ModelChoice, type ModelNames } from '../ai/models.ts';
import { createDesktopTransport } from '../ai/transport.ts';
import { useAiProviders, type ProviderState } from '../ai/use-ai-providers.ts';
import { beginBackgroundChange } from '../editor/background-images.ts';
import { announceAiBackgroundReveal } from '../editor/preview-motion.ts';
import type { SceneHistory } from '../editor/use-scene-history.ts';
import { backgroundMockScript, backgroundValidator, codeSourceOf } from './ai-background.ts';
import {
  createChatSaver,
  describeFailure,
  failureOf,
  withValidBackgrounds,
  type ChatFailure,
} from './chat-store.ts';
import {
  createChatSession,
  isRefining,
  messageBackground,
  type AiHistoryAccess,
  type ChatSession,
  type ChatState,
} from './chat-session.ts';

interface Options {
  history: Pick<SceneHistory, 'scene' | 'preview' | 'commit'>;
  /** The screenshot's dominant colours, heaviest first. */
  palette: readonly PaletteColour[];
  /** Counts the images the editor loaded; a new one brings its own conversation. 0: none yet. */
  imageId: number;
  /** The capture's id in the history, when it is kept there. */
  historyId: string | null;
}

/** Everything the chat panel shows and does. */
export interface ChatController {
  state: ChatState;
  access: AiAccess;
  /** The providers offered and where each stands; empty until the first detection is done. */
  providers: ProviderState[];
  /** The first detection is still running. */
  detecting: boolean;
  recheckProviders: () => void;
  /** What the next message is sent with; undefined until a provider is offered. */
  choice: ModelChoice | undefined;
  /** The models each provider offers, to name the one a reply used. */
  modelNames: ModelNames;
  /** The chosen provider is ready, so a message can be sent. */
  choiceReady: boolean;
  chooseModel: (provider: AiProvider, model: string | null) => void;
  /** The models starred in the picker. */
  favorites: readonly FavoriteModel[];
  toggleFavorite: (provider: AiProvider, model: string) => void;
  /** An image is loaded in the editor, not the empty canvas. */
  hasImage: boolean;
  effort: AiEffort;
  chooseEffort: (effort: AiEffort) => void;
  /** The canvas has generated code, so the next message changes it. */
  refining: boolean;
  /** The source of the canvas's code layer, to tell which reply is on the canvas. */
  canvasSource: string | undefined;
  /** The conversation is saved with the capture. */
  kept: boolean;
  /** The saved conversation is being read. */
  loading: boolean;
  notice: UserError | undefined;
  dismissNotice: () => void;
  send: (text: string) => void;
  stop: () => void;
  regenerate: () => void;
  startOver: () => void;
  /** Cancels any run and empties the conversation, as when the canvas is reset. */
  clear: () => void;
  useResult: (messageId: string) => void;
  /** Saves a reply's background as a preset; resolves true once it is saved. */
  savePreset: (messageId: string, name: string) => Promise<boolean>;
}

function historyAccess({ scene, preview, commit }: Options['history']): AiHistoryAccess {
  return { scene: () => scene, preview, commit };
}

/**
 * The AI background chat of the editor. The session lives as long as the editor, so a run goes on
 * while the panel is hidden. A new image cancels the run and shows its own conversation.
 */
export function useBackgroundChat({ history, palette, imageId, historyId }: Options): ChatController {
  const { t } = useTranslation();
  const access = useAiAccess();
  // A failure is worded when it is shown, and goes when another image is loaded.
  const [raised, setRaised] = useState<ChatFailure>();
  // Set once Rust reports that the capture is gone from the history, so nothing is kept.
  const [dropped, setDropped] = useState(false);
  const [shownFor, setShownFor] = useState(imageId);
  if (shownFor !== imageId) {
    setShownFor(imageId);
    setRaised(undefined);
    setDropped(false);
  }
  const report = setRaised;
  const notice = raised && describeFailure(t, raised);
  // The conversation read for one image; still being read until its key shows up here.
  const key = `${String(imageId)}:${historyId ?? ''}`;
  const [read, setRead] = useState<{ key: string; kept: boolean }>();
  const loading = imageId !== 0 && historyId !== null && read?.key !== key;
  const kept = read?.key === key && read.kept && !dropped;
  // The choice made in this session; until then, the one saved in settings.
  const [chosen, setChosen] = useState<AiEffort>();
  const effort = chosen ?? access.effort;

  const [saver] = useState(() =>
    createChatSaver({ onError: setRaised, onNotKept: () => { setDropped(true); } }),
  );
  const [session] = useState<ChatSession>(() =>
    createChatSession({
      start: ({ input, check, provider, model, effort: level, signal, onEvent }) => {
        const validator = backgroundValidator(check);
        const run = runTask(backgroundTask, input, {
          transport: createDesktopTransport(
            { provider, model },
            {},
            import.meta.env.DEV && provider === 'mock' ? backgroundMockScript() : null,
          ),
          provider: { name: provider, capabilities: [] },
          signal,
          effort: level,
          validate: validator.validate,
          onEvent,
        });
        return { fallback: run.fallback, done: run.done, noWebgl: validator.noWebgl };
      },
      history: historyAccess(history),
      beginBackgroundChange,
      onApplied: announceAiBackgroundReveal,
      save: saver.save,
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
    }),
  );
  // The session outlives renders, so it is pointed at the newest history after each one.
  useLayoutEffect(() => { session.attach(historyAccess(history)); });
  const state = useSyncExternalStore(session.subscribe, session.getState);

  // A new image cancels a run in flight, whose answer was written for the old one, and brings
  // the conversation kept for the new one. Going back to the empty canvas shows an empty one.
  useEffect(() => {
    let current = true;
    session.load(null, []);
    if (imageId !== 0 && historyId !== null) {
      // Waits for a reply still being saved, so reopening a capture never reads an older file.
      saver
        .settled()
        .then(() => commands.getChat(historyId))
        .then((result) => {
          if (!current) return;
          if (result.status === 'error') {
            // A conversation that cannot be read is left alone: saving over it would lose it.
            report(failureOf(result));
            setRead({ key, kept: false });
          } else {
            session.load(historyId, withValidBackgrounds(result.data));
            setRead({ key, kept: true });
          }
        })
        .catch((cause: unknown) => {
          if (!current) return;
          report({ kind: 'unexpected', cause });
          setRead({ key, kept: false });
        });
    }
    return () => {
      current = false;
      session.dispose();
    };
  }, [session, saver, imageId, historyId, key, report]);

  const { providers, detecting, recheck: recheckProviders } = useAiProviders();
  // The choice made in this session; until then, the one saved in settings.
  const [picked, setPicked] = useState<ModelChoice>();
  const choice = picked ?? initialChoice(providers, { provider: access.lastProvider, model: access.lastModel });
  const choiceReady = providers.some((p) => p.provider === choice?.provider && p.status === 'ready');
  const [starred, setStarred] = useState<readonly FavoriteModel[]>();
  const favorites = starred ?? access.favorites;

  const context = useCallback(
    () => (choice && choiceReady ? { palette, provider: choice.provider, model: choice.model, effort } : undefined),
    [palette, choice, choiceReady, effort],
  );

  const chooseEffort = useCallback(
    (next: AiEffort) => {
      setChosen(next);
      // Remembered for next time. A failed save leaves the choice applied for this session, and
      // the user is told it will not be kept.
      void commands.setAiEffort(next).then(
        (result) => {
          if (result.status === 'error') report(failureOf(result));
        },
        (cause: unknown) => { report({ kind: 'unexpected', cause }); },
      );
    },
    [report],
  );

  const chooseModel = useCallback(
    (provider: AiProvider, model: string | null) => {
      setPicked({ provider, model });
      // Remembered for next time; a failed save leaves the choice applied for this session.
      void commands.setAiModel(provider, model).then(
        (result) => {
          if (result.status === 'error') report(failureOf(result));
        },
        (cause: unknown) => { report({ kind: 'unexpected', cause }); },
      );
    },
    [report],
  );

  const toggleFavorite = useCallback(
    (provider: AiProvider, model: string) => {
      // The entry that stands for the CLI's default has no model name to keep.
      if (model === '') return;
      const before = favorites;
      const starredNow = before.some((f) => f.provider === provider && f.model === model);
      setStarred(
        starredNow
          ? before.filter((f) => !(f.provider === provider && f.model === model))
          : [...before, { provider, model }],
      );
      commands.setAiFavoriteModel(provider, model, !starredNow).then(
        (result) => {
          if (result.status === 'error') {
            setStarred(before);
            report(failureOf(result));
          } else {
            setStarred(result.data.ai.favoriteModels);
          }
        },
        (cause: unknown) => {
          setStarred(before);
          report({ kind: 'unexpected', cause });
        },
      );
    },
    [favorites, report],
  );

  const savePreset = useCallback(
    async (messageId: string, name: string): Promise<boolean> => {
      const message = session.getState().messages.find((candidate) => candidate.id === messageId);
      const background = message && messageBackground(message);
      if (!background) return false;
      try {
        const result = await saveUserPreset({ name, background });
        if (result.status === 'error') {
          report(failureOf(result));
          return false;
        }
        setRaised(undefined);
        return true;
      } catch (cause) {
        report({ kind: 'unexpected', cause });
        return false;
      }
    },
    [session, report],
  );

  return {
    state,
    access,
    providers,
    detecting,
    recheckProviders,
    choice,
    modelNames: Object.fromEntries(
      providers.flatMap((p) => (p.models === 'loading' ? [] : [[p.provider, p.models] as const])),
    ),
    choiceReady,
    chooseModel,
    favorites,
    toggleFavorite,
    hasImage: imageId !== 0,
    effort,
    chooseEffort,
    refining: isRefining(state, history.scene),
    canvasSource: codeSourceOf(history.scene.background),
    kept,
    loading,
    notice,
    dismissNotice: () => { setRaised(undefined); },
    send: (text) => {
      const ready = context();
      if (ready) session.send(text, ready);
    },
    stop: () => { session.cancel(); },
    regenerate: () => {
      const ready = context();
      if (ready) session.regenerate(ready);
    },
    startOver: () => { session.startOver(); },
    clear: () => {
      session.load(null, []);
      setRaised(undefined);
    },
    useResult: (messageId) => { session.useResult(messageId); },
    savePreset,
  };
}
