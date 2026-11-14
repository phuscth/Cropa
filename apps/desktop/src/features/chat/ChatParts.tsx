import { AGENT_ERROR_KINDS, TASK_ERROR_KINDS, type AiErrorKind } from '@cropa/ai';
import { Button, CheckCircleIcon, CheckIcon, ChevronRightIcon, CodeIcon, Input } from '@cropa/ui';
import { useEffect, useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { AiProvider } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import type { UserError } from '../../lib/errors.ts';
import { describeAiError } from '../ai/errors.ts';
import { providerName } from '../ai/providers.ts';
import { codeSourceOf, PRESET_NAME_MAX, presetNameFrom } from './ai-background.ts';
import {
  descriptionFor,
  durationParts,
  messageBackground,
  reachedCanvas,
  type ChatMessage,
  type ChatRun,
} from './chat-session.ts';
import { partialSource } from './partial-output.ts';

const KNOWN_ERRORS: readonly string[] = [...AGENT_ERROR_KINDS, ...TASK_ERROR_KINDS];

/** The time since `startedAt` as `m:ss`, counted up while it is on screen. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  const { minutes, seconds } = durationParts(now - startedAt);
  return <span className="tabular-nums">{`${minutes}:${String(seconds).padStart(2, '0')}`}</span>;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRightIcon
      className={`size-3.5 shrink-0 transition-transform duration-150 ease-enter ${open ? 'rotate-90' : ''}`}
    />
  );
}

/**
 * A block with a button header that opens and closes it. `autoOpen` is the state until the user
 * clicks. `action` sits beside the toggle, never inside it.
 */
function Disclosure({
  label,
  detail,
  action,
  autoOpen,
  children,
}: {
  label: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  autoOpen: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? autoOpen;
  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[14px] leading-5 font-normal text-muted-foreground transition-colors duration-150 hover:text-foreground"
          onClick={() => { setChosen(!open); }}
        >
          <Chevron open={open} />
          <span>{label}</span>
          {detail}
        </button>
        {action}
      </div>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

const blockClass =
  'mt-1 max-h-44 overflow-auto px-1.5 pb-1 text-[13px] leading-5 font-normal text-muted-foreground whitespace-pre-wrap break-words';
const codeClass =
  'mt-1 max-h-44 overflow-auto rounded-lg bg-foreground/[0.04] px-2.5 py-2 font-mono text-[11px] leading-[1.45] font-normal whitespace-pre text-muted-foreground';
const chipClass =
  'inline-flex items-center gap-1 rounded-md bg-foreground/[0.07] px-2 py-1 text-[12px] font-normal text-muted-foreground';

function lineCount(source: string): number {
  return source === '' ? 0 : source.split('\n').length;
}

/** One entry of the work log: a marker on a vertical line, and its content. */
function TimelineStep({ marker, children }: { marker?: ReactNode; children: ReactNode }) {
  return (
    <li className="group/step flex gap-2">
      <div className="relative w-4 shrink-0">
        {marker ?? <span className="absolute top-[9px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-foreground/35" />}
        <span className="absolute top-[21px] bottom-0 left-1/2 w-px -translate-x-1/2 bg-foreground/12 group-last/step:hidden" />
      </div>
      <div className="min-w-0 flex-1 pb-3 group-last/step:pb-0">{children}</div>
    </li>
  );
}

/** A step that is one line of text, with an optional pulsing dot while it is under way. */
function TextStep({ pulse = false, strong = false, children }: { pulse?: boolean; strong?: boolean; children: ReactNode }) {
  const dot = (
    <span
      className={`absolute top-[9px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-foreground/35 ${pulse ? 'animate-pulse motion-reduce:animate-none' : ''}`}
    />
  );
  return (
    <TimelineStep marker={dot}>
      <p className={`flex min-h-6 items-center gap-2 text-[14px] leading-5 font-normal ${strong ? 'text-foreground' : 'text-muted-foreground'}`}>
        {children}
      </p>
    </TimelineStep>
  );
}

function ThinkingStep({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation();
  return (
    <TimelineStep>
      <Disclosure label={t('chat.thinking')} autoOpen={streaming}>
        <p className={blockClass}>{text}</p>
      </Disclosure>
    </TimelineStep>
  );
}

function CodeStep({ source, streaming }: { source: string; streaming: boolean }) {
  const { t } = useTranslation();
  return (
    <TimelineStep>
      <Disclosure
        label={t(streaming ? 'chat.code' : 'chat.log.wroteCode')}
        detail={
          <span className={chipClass}>
            <CodeIcon className="size-3.5" />
            <span className="tabular-nums">{t('chat.lineCount', { count: lineCount(source) })}</span>
          </span>
        }
        autoOpen={streaming}
      >
        <pre className={codeClass}>{source}</pre>
      </Disclosure>
    </TimelineStep>
  );
}

/** The work of one reply: a toggle and, inside, its steps along a timeline. */
function WorkLog({
  label,
  action,
  autoOpen,
  children,
}: {
  label: ReactNode;
  action?: ReactNode;
  autoOpen: boolean;
  children: ReactNode;
}) {
  return (
    <Disclosure label={label} action={action} autoOpen={autoOpen}>
      <ol className="mt-1 ml-3 flex flex-col">{children}</ol>
    </Disclosure>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto w-fit max-w-full rounded-3xl bg-foreground/[0.07] px-3 py-2.5 text-[14px] leading-6 font-normal break-words whitespace-pre-wrap text-foreground">
      {text}
    </div>
  );
}

const proseClass = 'px-1.5 text-[15px] leading-[26px] font-normal break-words whitespace-pre-wrap text-foreground/85';

function AgentHeader({ provider, effort }: { provider: string | null | undefined; effort: string | null | undefined }) {
  const { t } = useTranslation();
  const parts = [
    provider ? providerName(t, provider as AiProvider) : undefined,
    effort ? t(`chat.effort.${effort}`) : undefined,
  ].filter((part): part is string => part !== undefined);
  return (
    <p className="flex items-baseline gap-2 px-1.5">
      <span className="text-[13px] font-medium">{t('chat.agentName')}</span>
      {parts.length > 0 && <span className="text-[12px] font-normal text-muted-foreground">{parts.join(' · ')}</span>}
    </p>
  );
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
    <div aria-live="off" aria-busy="true" className="flex w-full flex-col gap-2">
      <AgentHeader provider={run.provider} effort={run.effort} />
      {/* Closed until the user opens it, so streamed thinking and code don't fill the list. */}
      <WorkLog
        autoOpen={false}
        label={
          <>
            {t('chat.log.working')} <Elapsed key={run.startedAt} startedAt={run.startedAt} />
          </>
        }
        action={
          <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-tiny" onClick={onStop}>
            {t('chat.stop')}
          </Button>
        }
      >
        {run.thinking !== '' && <ThinkingStep text={run.thinking} streaming />}
        {source !== '' && <CodeStep source={source} streaming />}
        <TextStep pulse>{stage}</TextStep>
      </WorkLog>
      {run.text !== '' && <p className={proseClass}>{run.text}</p>}
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
  const reached = reachedCanvas(message);
  const onCanvas = reached && source !== undefined && source === canvasSource;
  const elapsedMs = message.elapsedMs ?? undefined;

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

  let logLabel = t('chat.log.details');
  if (elapsedMs !== undefined) {
    const { minutes, seconds } = durationParts(elapsedMs);
    const duration = minutes > 0 ? t('chat.duration.minutes', { minutes, seconds }) : t('chat.duration.seconds', { seconds });
    logLabel = t('chat.log.worked', { duration });
  }
  const showLog = Boolean(message.thinking) || source !== undefined || elapsedMs !== undefined;

  return (
    <div className="flex w-full flex-col gap-2">
      <AgentHeader provider={message.provider} effort={message.effort} />
      {showLog && (
        <WorkLog label={logLabel} autoOpen={false}>
          {message.thinking && <ThinkingStep text={message.thinking} streaming={false} />}
          {source !== undefined && <CodeStep source={source} streaming={false} />}
          {applied ? (
            <TimelineStep
              marker={<CheckCircleIcon className="absolute top-1 left-0 size-4 text-success" />}
            >
              <p className="flex min-h-6 items-center text-[14px] leading-5 font-normal text-foreground">
                {t('chat.log.finished')}
              </p>
            </TimelineStep>
          ) : (
            message.outcome === 'failed' && <TextStep>{t('chat.log.failed')}</TextStep>
          )}
          {message.outcome === 'cancelled' && <TextStep>{t('chat.log.stopped')}</TextStep>}
        </WorkLog>
      )}
      {message.text !== '' && <p className={proseClass}>{message.text}</p>}
      {message.outcome === 'failed' && <ErrorNotice error={failureOf(t, message)} />}
      {message.outcome === 'cancelled' && (
        <p className="px-1.5 text-control-sm font-normal text-muted-foreground">{t('chat.cancelled')}</p>
      )}
      {applied && !reached && (
        <p className="px-1.5 text-control-sm font-normal text-muted-foreground">{t('chat.notApplied')}</p>
      )}
      {reached && (
        <p className="flex items-center gap-2 px-1.5 text-control-sm font-normal">
          <span className="inline-flex items-center gap-1 text-success">
            <CheckIcon className="size-3.5" />
            {t('chat.applied')}
          </span>
          {onCanvas && <span className="text-muted-foreground">{t('chat.onCanvas')}</span>}
        </p>
      )}
      {applied && background && (
        <div className="flex flex-wrap gap-1.5 px-1.5">
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
          className="flex flex-col gap-2 px-1.5"
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
      {saved && <p role="status" className="px-1.5 text-control-sm font-normal text-muted-foreground">{t('chat.saved')}</p>}
    </div>
  );
}
