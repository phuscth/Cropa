import { AGENT_ERROR_KINDS, TASK_ERROR_KINDS, type AiErrorKind } from '@cropa/ai';
import { Button, Input } from '@cropa/ui';
import { useEffect, useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { AiProvider } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import type { UserError } from '../../lib/errors.ts';
import { describeAiError } from '../ai/errors.ts';
import { providerName } from '../ai/providers.ts';
import { codeSourceOf, PRESET_NAME_MAX, presetNameFrom } from './ai-background.ts';
import { descriptionFor, messageBackground, type ChatMessage, type ChatRun } from './chat-session.ts';
import { partialSource } from './partial-output.ts';

const KNOWN_ERRORS: readonly string[] = [...AGENT_ERROR_KINDS, ...TASK_ERROR_KINDS];

/** Whole seconds since `startedAt`, counted up while it is on screen. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <span className="text-caption tabular-nums">{t('chat.elapsed', { seconds })}</span>;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-3.5 shrink-0 transition-transform duration-150 ease-enter ${open ? 'rotate-90' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

/** A block with a button header that opens and closes it. `autoOpen` is the state until the user clicks. */
function Disclosure({
  label,
  detail,
  autoOpen,
  children,
}: {
  label: string;
  detail?: string | undefined;
  autoOpen: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? autoOpen;
  return (
    <div className="rounded-lg bg-secondary/60">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        className="focus-ring flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-tiny text-muted-foreground hover:text-foreground"
        onClick={() => { setChosen(!open); }}
      >
        <Chevron open={open} />
        <span>{label}</span>
        {detail && <span className="ml-auto tabular-nums">{detail}</span>}
      </button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

const blockClass =
  'max-h-44 overflow-auto px-2.5 pb-2 text-caption whitespace-pre-wrap break-words';
const codeClass =
  'max-h-44 overflow-auto px-2.5 pb-2 font-mono text-[11px] leading-[1.45] whitespace-pre text-muted-foreground';

function lineCount(source: string): number {
  return source === '' ? 0 : source.split('\n').length;
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation();
  return (
    <Disclosure label={t('chat.thinking')} autoOpen={streaming}>
      <p className={blockClass}>{text}</p>
    </Disclosure>
  );
}

function CodeBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const { t } = useTranslation();
  return (
    <Disclosure
      label={t('chat.code')}
      detail={t('chat.lineCount', { count: lineCount(source) })}
      autoOpen={streaming}
    >
      <pre className={codeClass}>{source}</pre>
    </Disclosure>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto max-w-[88%] rounded-xl bg-primary px-3 py-2 text-control-sm font-normal break-words whitespace-pre-wrap text-primary-foreground">
      {text}
    </div>
  );
}

function Meta({ provider, effort }: { provider: string | null | undefined; effort: string | null | undefined }) {
  const { t } = useTranslation();
  const parts = [
    provider ? providerName(t, provider as AiProvider) : undefined,
    effort ? t(`chat.effort.${effort}`) : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? null : <p className="text-caption">{parts.join(' · ')}</p>;
}

/** The reply being written: its thinking, its code, and where it stands. */
export function RunningReply({ run, onStop }: { run: ChatRun; onStop: () => void }) {
  const { t } = useTranslation();
  const source = partialSource(run.output);
  const stage = t(
    run.stage === 'started'
      ? 'chat.stage.starting'
      : run.stage === 'writing'
        ? 'chat.stage.writing'
        : run.stage === 'checking'
          ? 'chat.stage.checking'
          : 'chat.stage.retrying',
  );
  return (
    // Not announced chunk by chunk: the finished reply is.
    <div aria-live="off" aria-busy="true" className="flex max-w-[94%] flex-col gap-2">
      <Meta provider={run.provider} effort={run.effort} />
      {run.thinking !== '' && <ThinkingBlock text={run.thinking} streaming />}
      {run.text !== '' && <p className="text-control-sm font-normal break-words whitespace-pre-wrap">{run.text}</p>}
      {source !== '' && <CodeBlock source={source} streaming />}
      <p className="flex items-center gap-2 text-control-sm font-normal text-muted-foreground">
        <span>{stage}</span>
        <Elapsed key={run.startedAt} startedAt={run.startedAt} />
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onStop}>
          {t('chat.stop')}
        </Button>
      </p>
    </div>
  );
}


function failureOf(t: ReturnType<typeof useTranslation>['t'], message: ChatMessage): UserError {
  const unchanged = message.unchanged === true;
  if (message.error === 'no-webgl') {
    return {
      what: t('chat.noWebgl.what'),
      why: t('chat.noWebgl.why'),
      next: t(unchanged ? 'chat.noWebgl.nextKept' : 'chat.noWebgl.next'),
    };
  }
  const kind = (KNOWN_ERRORS.includes(message.error ?? '') ? message.error : 'Protocol') as AiErrorKind;
  const error = describeAiError(t, kind, providerName(t, (message.provider ?? 'claude') as AiProvider));
  return unchanged ? { ...error, next: `${error.next} ${t('chat.unchanged')}` } : error;
}

export interface ReplyActions {
  onUseResult: (messageId: string) => void;
  onRegenerate: () => void;
  /** Resolves true once the preset is saved. */
  onSavePreset: (messageId: string, name: string) => Promise<boolean>;
}

/** A finished reply, with what can be done with its background. */
export function AgentReply({
  message,
  index,
  messages,
  canvasSource,
  latestApplied,
  busy,
  actions,
}: {
  message: ChatMessage;
  index: number;
  messages: readonly ChatMessage[];
  canvasSource: string | undefined;
  /** The newest applied reply, the one that can be regenerated. */
  latestApplied: boolean;
  /** A run is in flight, so nothing here can start another. */
  busy: boolean;
  actions: ReplyActions;
}) {
  const { t } = useTranslation();
  const [naming, setNaming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const background = messageBackground(message);
  const source = background && codeSourceOf(background);
  const applied = message.outcome === 'applied';
  const onCanvas = applied && source !== undefined && source === canvasSource;

  const savePreset = async (event: SyntheticEvent) => {
    event.preventDefault();
    const name = naming?.trim() ?? '';
    if (name === '' || saving) return;
    setSaving(true);
    const done = await actions.onSavePreset(message.id, name);
    setSaving(false);
    if (done) {
      setNaming(null);
      setSaved(true);
    }
  };

  return (
    <div className="flex max-w-[94%] flex-col gap-2">
      <Meta provider={message.provider} effort={message.effort} />
      {message.thinking && <ThinkingBlock text={message.thinking} streaming={false} />}
      {message.text !== '' && <p className="text-control-sm font-normal break-words whitespace-pre-wrap">{message.text}</p>}
      {source !== undefined && <CodeBlock source={source} streaming={false} />}
      {message.outcome === 'failed' && <ErrorNotice error={failureOf(t, message)} />}
      {message.outcome === 'cancelled' && (
        <p className="text-control-sm font-normal text-muted-foreground">{t('chat.cancelled')}</p>
      )}
      {applied && (
        <p className="flex items-center gap-2 text-control-sm font-normal">
          <span className="inline-flex items-center gap-1 text-success">
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m3.5 8.5 3 3 6-7" />
            </svg>
            {t('chat.applied')}
          </span>
          {onCanvas && <span className="text-muted-foreground">{t('chat.onCanvas')}</span>}
        </p>
      )}
      {applied && background && (
        <div className="flex flex-wrap gap-1.5">
          {!onCanvas && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => { actions.onUseResult(message.id); }}>
              {t('chat.useThis')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={naming !== null}
            onClick={() => {
              setSaved(false);
              setNaming(presetNameFrom(descriptionFor(messages, index)));
            }}
          >
            {t('chat.saveAsPreset')}
          </Button>
          {latestApplied && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              title={t('chat.regenerateHint')}
              aria-label={`${t('chat.regenerate')}. ${t('chat.regenerateHint')}`}
              onClick={actions.onRegenerate}
            >
              {t('chat.regenerate')}
            </Button>
          )}
        </div>
      )}
      {naming !== null && (
        <form
          className="flex flex-col gap-2"
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
            aria-label={t('chat.presetName')}
            placeholder={t('chat.presetName')}
            value={naming}
            onChange={(event) => { setNaming(event.target.value); }}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving || naming.trim() === ''}>
              {t('chat.save')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setNaming(null); }}>
              {t('chat.cancel')}
            </Button>
          </div>
        </form>
      )}
      {saved && <p role="status" className="text-control-sm font-normal text-muted-foreground">{t('chat.saved')}</p>}
    </div>
  );
}
