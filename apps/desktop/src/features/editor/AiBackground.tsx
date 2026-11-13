import { backgroundTask, runTask } from '@cropa/ai';
import type { PaletteColour } from '@cropa/core';
import { Button, Input, SegmentedControl, SegmentedControlItem } from '@cropa/ui';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type SyntheticEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type AiEffort } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { saveUserPreset } from '../../lib/user-presets.ts';
import { useAiAccess } from '../ai/access.ts';
import { AiGate } from '../ai/AiGate.tsx';
import { describeAiError } from '../ai/errors.ts';
import { providerName } from '../ai/providers.ts';
import { createDesktopTransport } from '../ai/transport.ts';
import { Section } from './Section.tsx';
import { createAiBackgroundSession, isRefining, type AiHistoryAccess } from './ai-background-session.ts';
import {
  backgroundMockScript,
  backgroundValidator,
  codeSourceOf,
  PRESET_NAME_MAX,
  presetNameFrom,
} from './ai-background.ts';
import { beginBackgroundChange } from './background-images.ts';
import { announceAiBackgroundReveal } from './preview-motion.ts';
import type { SceneHistory } from './use-scene-history.ts';

interface Props {
  history: Pick<SceneHistory, 'scene' | 'preview' | 'commit'>;
  /** The screenshot's dominant colours, heaviest first. */
  palette: readonly PaletteColour[];
}

const EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high'];
const STATUS_MS = 6000;

const textareaClass =
  'focus-ring w-full resize-none rounded-lg border border-input bg-card px-3 py-2 text-control-sm transition-[color,border-color,box-shadow] duration-150 ease-enter placeholder:text-tertiary-foreground hover:border-foreground/25 focus-visible:border-ring disabled:pointer-events-none disabled:opacity-50';

function historyAccess({ scene, preview, commit }: Props['history']): AiHistoryAccess {
  return { scene: () => scene, preview, commit };
}

/** Whole seconds since `startedAt`, counted up while it is on screen. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span className="text-sm text-muted-foreground tabular-nums">
      {t('editor.aiBackground.elapsed', { seconds })}
    </span>
  );
}

/**
 * Describe a background and let the user's AI write it, then change it, run it again or keep it
 * as a preset. The closest preset shows at once; the AI's animated background replaces it once
 * it has run in the sandbox. Nothing but the description, the palette colours, the frame size and
 * the current module leaves the window: no image is sent.
 */
export function AiBackground({ history, palette }: Props) {
  const { t } = useTranslation();
  const access = useAiAccess();
  const fieldId = useId();
  const changeId = useId();
  const { scene } = history;
  const [description, setDescription] = useState('');
  // The change typed for one module; a new module starts with an empty box.
  const [change, setChange] = useState<{ source: string | undefined; text: string }>({
    source: undefined,
    text: '',
  });
  const [notice, setNotice] = useState<UserError>();
  const [naming, setNaming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>();
  // The choice made in this session; until then, the one saved in settings.
  const [chosen, setChosen] = useState<AiEffort>();
  const effort = chosen ?? access.effort;
  const statusTimer = useRef<number>(undefined);
  useEffect(() => () => { window.clearTimeout(statusTimer.current); }, []);

  const [session] = useState(() =>
    createAiBackgroundSession({
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
      now: () => Date.now(),
    }),
  );
  // The session outlives renders, so it is pointed at the newest history after each one.
  useLayoutEffect(() => { session.attach(historyAccess(history)); });
  const state = useSyncExternalStore(session.subscribe, session.getState);

  // Leaving the editor, or loading another screenshot, cancels a run in flight: its answer was
  // written for the old image.
  useEffect(() => () => { session.dispose(); }, [palette, session]);

  const provider = access.provider;
  const running = state.run !== null;
  const source = codeSourceOf(scene.background);
  const refining = isRefining(state, scene);
  const info = session.infoFor(scene);
  const changeText = change.source === source ? change.text : '';

  const chooseEffort = (next: AiEffort) => {
    setChosen(next);
    // Remembered for next time. A failed save leaves the choice applied for this session, and
    // the user is told it will not be kept.
    void commands.setAiEffort(next).then(
      (result) => {
        if (result.status === 'error') setNotice(describeCommandError(t, result.error));
      },
      (cause: unknown) => { setNotice(describeUnexpected(t, cause)); },
    );
  };

  const runNotice: UserError | undefined = (() => {
    const failure = state.notice;
    if (!failure) return undefined;
    if (failure.reason === 'no-webgl') {
      return {
        what: t('editor.aiBackground.noWebgl.what'),
        why: t('editor.aiBackground.noWebgl.why'),
        next: t(failure.unchanged ? 'editor.aiBackground.noWebgl.nextKept' : 'editor.aiBackground.noWebgl.next'),
      };
    }
    const error = describeAiError(t, failure.reason, providerName(t, failure.provider));
    return failure.unchanged ? { ...error, next: `${error.next} ${t('editor.aiBackground.unchanged')}` } : error;
  })();

  const showStatus = (text: string) => {
    window.clearTimeout(statusTimer.current);
    setStatus(text);
    statusTimer.current = window.setTimeout(() => { setStatus(undefined); }, STATUS_MS);
  };

  const openNaming = () => {
    setStatus(undefined);
    setNaming(info ? presetNameFrom(info.description) : '');
  };

  const savePreset = async (event: SyntheticEvent) => {
    event.preventDefault();
    const name = naming?.trim() ?? '';
    if (name === '' || saving) return;
    setSaving(true);
    try {
      const result = await saveUserPreset({ name, background: scene.background });
      if (result.status === 'error') {
        setNotice(describeCommandError(t, result.error));
      } else {
        setNotice(undefined);
        setNaming(null);
        showStatus(t('editor.aiBackground.saved'));
      }
    } catch (cause) {
      setNotice(describeUnexpected(t, cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={t('editor.aiBackground.title')}>
      <AiGate access={access}>
        {(enabled) => (
          <div className="flex w-full flex-col items-start gap-2">
            {refining ? (
              <>
                {info && (
                  <p className="text-xs text-muted-foreground">
                    {t('editor.aiBackground.madeWith', {
                      provider: providerName(t, info.provider),
                      effort: t(`editor.aiBackground.effort.${info.effort}`),
                    })}
                  </p>
                )}
                <label htmlFor={changeId} className="text-sm">
                  {t('editor.aiBackground.changeLabel')}
                </label>
                <textarea
                  id={changeId}
                  rows={3}
                  maxLength={500}
                  value={changeText}
                  disabled={!enabled || running}
                  placeholder={t('editor.aiBackground.changePlaceholder')}
                  onChange={(event) => { setChange({ source, text: event.target.value }); }}
                  className={textareaClass}
                />
              </>
            ) : (
              <>
                <label htmlFor={fieldId} className="text-sm">
                  {t('editor.aiBackground.label')}
                </label>
                <textarea
                  id={fieldId}
                  rows={3}
                  maxLength={500}
                  value={description}
                  disabled={!enabled || running}
                  placeholder={t('editor.aiBackground.placeholder')}
                  onChange={(event) => { setDescription(event.target.value); }}
                  className={textareaClass}
                />
              </>
            )}
            <div className="flex w-full flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('editor.aiBackground.effort.label')}</span>
              <SegmentedControl
                aria-label={t('editor.aiBackground.effort.label')}
                value={effort}
                disabled={!enabled || running}
                onValueChange={(next) => { chooseEffort(next as AiEffort); }}
              >
                {EFFORTS.map((level) => (
                  <SegmentedControlItem key={level} value={level}>
                    {t(`editor.aiBackground.effort.${level}`)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              <p className="text-xs text-muted-foreground">{t('editor.aiBackground.effort.hint')}</p>
            </div>
            {state.run ? (
              <div className="flex w-full items-center gap-2">
                <span role="status" className="text-sm text-muted-foreground">
                  {state.run.phase === 'checking'
                    ? t('editor.aiBackground.checking')
                    : t('editor.aiBackground.writing')}
                </span>
                <Elapsed key={state.run.startedAt} startedAt={state.run.startedAt} />
                <Button variant="secondary" size="sm" onClick={() => { session.cancel(); }}>
                  {t('editor.aiBackground.cancel')}
                </Button>
              </div>
            ) : refining ? (
              <div className="flex w-full flex-col gap-2">
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={!enabled || !provider || changeText.trim() === ''}
                  onClick={() => {
                    if (provider) session.refine(changeText, palette, provider, effort);
                  }}
                >
                  {t('editor.aiBackground.apply')}
                </Button>
                {info && (
                  <Button
                    variant="secondary"
                    className="w-full"
                    disabled={!enabled || !provider}
                    title={t('editor.aiBackground.regenerateHint')}
                    aria-label={`${t('editor.aiBackground.regenerate')}. ${t('editor.aiBackground.regenerateHint')}`}
                    onClick={() => {
                      if (provider) session.regenerate(palette, provider, effort);
                    }}
                  >
                    {t('editor.aiBackground.regenerate')}
                  </Button>
                )}
                <Button variant="secondary" className="w-full" onClick={() => { session.startOver(); }}>
                  {t('editor.aiBackground.startOver')}
                </Button>
                <Button variant="secondary" className="w-full" disabled={naming !== null} onClick={openNaming}>
                  {t('editor.aiBackground.saveAsPreset')}
                </Button>
              </div>
            ) : (
              <Button
                variant="secondary"
                className="w-full"
                disabled={!enabled || !provider || description.trim() === ''}
                onClick={() => {
                  if (provider) session.generate(description, palette, provider, effort);
                }}
              >
                {t('editor.aiBackground.generate')}
              </Button>
            )}
            {refining && naming !== null && (
              <form
                className="flex w-full flex-col gap-2"
                onSubmit={(event) => { void savePreset(event); }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    setNaming(null);
                  }
                }}
              >
                <Input
                  autoFocus
                  maxLength={PRESET_NAME_MAX}
                  aria-label={t('editor.aiBackground.presetName')}
                  placeholder={t('editor.aiBackground.presetName')}
                  value={naming}
                  onChange={(event) => { setNaming(event.target.value); }}
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={saving || naming.trim() === ''}>
                    {t('editor.aiBackground.save')}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setNaming(null); }}>
                    {t('editor.aiBackground.cancel')}
                  </Button>
                </div>
              </form>
            )}
            {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
          </div>
        )}
      </AiGate>
      {runNotice && <ErrorNotice error={runNotice} onDismiss={() => { session.dismissNotice(); }} />}
      {notice && <ErrorNotice error={notice} onDismiss={() => { setNotice(undefined); }} />}
    </Section>
  );
}
