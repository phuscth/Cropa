import { backgroundTask, runTask } from '@cropa/ai';
import type { PaletteColour } from '@cropa/core';
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type AiEffort } from '../../lib/bindings.ts';
import { type UserError } from '../../lib/errors.ts';
import { saveUserPreset } from '../../lib/user-presets.ts';
import { useAiAccess, type AiAccess } from '../ai/access.ts';
import { createDesktopTransport } from '../ai/transport.ts';
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
  const [shownFor, setShownFor] = useState(imageId);
  if (shownFor !== imageId) {
    setShownFor(imageId);
    setRaised(undefined);
  }
  const report = setRaised;
  const notice = raised && describeFailure(t, raised);
  // The conversation read for one image; still being read until its key shows up here.
  const key = `${String(imageId)}:${historyId ?? ''}`;
  const [read, setRead] = useState<{ key: string; kept: boolean }>();
  const loading = imageId !== 0 && historyId !== null && read?.key !== key;
  const kept = read?.key === key && read.kept;
  // The choice made in this session; until then, the one saved in settings.
  const [chosen, setChosen] = useState<AiEffort>();
  const effort = chosen ?? access.effort;

  const [session] = useState<ChatSession>(() =>
    createChatSession({
      start: ({ input, check, provider, effort: level, signal, onEvent }) => {
        const validator = backgroundValidator(check);
        const run = runTask(backgroundTask, input, {
          transport: createDesktopTransport(
            provider,
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
      save: createChatSaver(report),
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
    }),
  );
  // The session outlives renders, so it is pointed at the newest history after each one.
  useLayoutEffect(() => { session.attach(historyAccess(history)); });
  const state = useSyncExternalStore(session.subscribe, session.getState);

  // A new image cancels a run in flight, whose answer was written for the old one, and brings
  // the conversation kept for the new one.
  useEffect(() => {
    if (imageId === 0) return undefined;
    let current = true;
    session.load(null, []);
    if (historyId !== null) {
      commands
        .getChat(historyId)
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
  }, [session, imageId, historyId, key, report]);

  const provider = access.provider;
  const context = useCallback(
    () => (provider ? { palette, provider, effort } : undefined),
    [palette, provider, effort],
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
    useResult: (messageId) => { session.useResult(messageId); },
    savePreset,
  };
}
