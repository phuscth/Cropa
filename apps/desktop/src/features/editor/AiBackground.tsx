import { backgroundTask, runTask } from '@cropa/ai';
import type { PaletteColour } from '@cropa/core';
import { Button, SegmentedControl, SegmentedControlItem } from '@cropa/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type AiEffort } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import type { UserError } from '../../lib/errors.ts';
import { useAiAccess } from '../ai/access.ts';
import { AiGate } from '../ai/AiGate.tsx';
import { describeAiError } from '../ai/errors.ts';
import { providerName } from '../ai/providers.ts';
import { createDesktopTransport } from '../ai/transport.ts';
import {
  applyGenerated,
  backgroundMockScript,
  backgroundRequest,
  backgroundValidator,
  backgroundWhileWaiting,
} from './ai-background.ts';
import { beginBackgroundChange } from './background-images.ts';
import { applyBackground } from './scene-edits.ts';
import type { SceneHistory } from './use-scene-history.ts';

interface Props {
  history: Pick<SceneHistory, 'scene' | 'edit'>;
  /** The screenshot's dominant colours, heaviest first. */
  palette: readonly PaletteColour[];
}

const EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high'];

type Phase = 'idle' | 'writing' | 'checking';

/**
 * Describe a background and let the user's AI write it. The closest preset shows at once; the
 * AI's animated background replaces it once it has run in the sandbox. Nothing but the
 * description, the palette colours and the frame size leaves the window: no image is sent.
 */
export function AiBackground({ history, palette }: Props) {
  const { t } = useTranslation();
  const access = useAiAccess();
  const fieldId = useId();
  const { scene, edit } = history;
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<UserError>();
  // The choice made in this session; until then, the one saved in settings.
  const [chosen, setChosen] = useState<AiEffort>();
  const effort = chosen ?? access.effort;
  const controller = useRef<AbortController>(undefined);

  // Leaving the editor, or loading another screenshot, cancels a run in flight: its answer was
  // written for the old image.
  useEffect(() => () => { controller.current?.abort(); }, [palette]);

  const provider = access.provider;
  const running = phase !== 'idle';

  const chooseEffort = (next: AiEffort) => {
    setChosen(next);
    // Remembered for next time; a failed save only means the choice lasts this session.
    void Promise.resolve(commands.setAiEffort(next)).catch(() => undefined);
  };

  const generate = () => {
    if (!provider || description.trim() === '') return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const isCurrent = beginBackgroundChange();
    setNotice(undefined);
    setPhase('writing');

    const { input, check } = backgroundRequest(scene, description, palette);
    const validator = backgroundValidator(check);
    const name = providerName(t, provider);
    const run = runTask(backgroundTask, input, {
      transport: createDesktopTransport(
        provider,
        {},
        import.meta.env.DEV && provider === 'mock' ? backgroundMockScript() : null,
      ),
      provider: { name: provider, capabilities: [] },
      signal: abort.signal,
      effort,
      validate: validator.validate,
      onEvent: (event) => {
        if (abort.signal.aborted) return;
        if (event.type === 'attempt') setPhase('writing');
        if (event.type === 'validating') setPhase('checking');
      },
    });
    // The closest preset is there while the AI works (builtin presets draw no image), unless the
    // scene already has generated code: that stays until the answer arrives.
    const shown = backgroundWhileWaiting(scene.background, run.fallback);
    edit((s) => applyBackground(s, shown));

    void run.done.then((out) => {
      if (controller.current === abort) {
        controller.current = undefined;
        setPhase('idle');
      }
      // Another background was chosen meanwhile, or the run was cancelled: leave the scene alone.
      if (abort.signal.aborted || !isCurrent()) return;
      if (out.source === 'ai') {
        edit((s) => applyGenerated(s, shown, out.result));
      } else if (validator.noWebgl()) {
        setNotice({
          what: t('editor.aiBackground.noWebgl.what'),
          why: t('editor.aiBackground.noWebgl.why'),
          next: t('editor.aiBackground.noWebgl.next'),
        });
      } else if (out.notice?.kind !== 'Cancelled') {
        setNotice(describeAiError(t, out.notice?.kind ?? 'Protocol', name));
      }
    });
  };

  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <h4 className="text-xs font-medium text-muted-foreground">{t('editor.aiBackground.title')}</h4>
      <label htmlFor={fieldId} className="text-sm">
        {t('editor.aiBackground.label')}
      </label>
      <AiGate access={access}>
        {(enabled) => (
          <div className="flex w-full flex-col items-start gap-2">
            <textarea
              id={fieldId}
              rows={3}
              maxLength={500}
              value={description}
              disabled={!enabled || running}
              placeholder={t('editor.aiBackground.placeholder')}
              onChange={(event) => { setDescription(event.target.value); }}
              className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
            />
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
            {running ? (
              <div className="flex items-center gap-2">
                <span role="status" className="text-sm text-muted-foreground">
                  {phase === 'checking'
                    ? t('editor.aiBackground.checking')
                    : t('editor.aiBackground.writing')}
                </span>
                <Button variant="outline" size="sm" onClick={() => { controller.current?.abort(); }}>
                  {t('editor.aiBackground.cancel')}
                </Button>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={!enabled || description.trim() === ''}
                onClick={generate}
              >
                {t('editor.aiBackground.generate')}
              </Button>
            )}
          </div>
        )}
      </AiGate>
      {notice && <ErrorNotice error={notice} onDismiss={() => { setNotice(undefined); }} />}
    </div>
  );
}
