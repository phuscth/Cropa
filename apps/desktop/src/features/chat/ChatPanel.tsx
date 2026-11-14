import {
  Button,
  ChatIcon,
  ChevronDownIcon,
  CloseIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  ImageIcon,
  RestartIcon,
  SparklesIcon,
  StopIcon,
} from '@cropa/ui';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { AiEffort } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { AiGate } from '../ai/AiGate.tsx';
import { providerName } from '../ai/providers.ts';
import { AgentReply, RunningReply, UserBubble, type ReplyActions } from './ChatParts.tsx';
import { reachedCanvas } from './chat-session.ts';
import type { ChatController } from './use-background-chat.ts';

const EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high'];
const MAX_MESSAGE_CHARS = 500;
/** The list follows new content while it is within this many pixels of the bottom. */
const STICK_PX = 32;

function Composer({ chat }: { chat: ChatController }) {
  const { t } = useTranslation();
  const fieldId = useId();
  const hintId = useId();
  const [text, setText] = useState('');
  const { state, access, refining, loading } = chat;
  const running = state.run !== null;

  const send = () => {
    if (text.trim() === '' || running || loading) return;
    chat.send(text);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter confirms a word being composed in some input methods; it must not send.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const level = t(`chat.effort.${chat.effort}`);
  const trayItem = 'inline-flex items-center gap-1 text-[12px] font-normal text-muted-foreground';
  const showNotKept = !chat.kept && !chat.loading && !chat.notice;

  return (
    <div className="flex shrink-0 flex-col gap-2 p-3 pt-1">
      <AiGate access={access}>
        {(enabled) => (
          <div className="flex w-full flex-col">
            <label htmlFor={fieldId} className="sr-only">
              {t('chat.messageLabel')}
            </label>
            <div className="rounded-[18px] border border-foreground/15 bg-foreground/[0.045] transition-colors duration-150 focus-within:border-ring">
              <textarea
                id={fieldId}
                rows={2}
                maxLength={MAX_MESSAGE_CHARS}
                value={text}
                disabled={!enabled || running || loading}
                placeholder={t(refining ? 'chat.placeholder.refine' : 'chat.placeholder.generate')}
                onChange={(event) => { setText(event.target.value); }}
                onKeyDown={onKeyDown}
                className="block max-h-40 min-h-[60px] w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pt-4 pb-2.5 text-[14px] leading-5 font-normal outline-none [field-sizing:content] placeholder:text-tertiary-foreground disabled:opacity-50"
              />
              <div className="flex items-center gap-1 px-3 pb-3">
                {refining && (
                  <Button
                    variant="ghost"
                    className="h-8 gap-1.5 rounded-[10px] px-2 text-tiny"
                    disabled={running}
                    onClick={chat.startOver}
                  >
                    <RestartIcon className="size-3.5" />
                    {t('chat.startOver')}
                  </Button>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        className="h-8 gap-1 rounded-[10px] px-2 text-tiny"
                        aria-label={t('chat.effort.picker', { level })}
                        disabled={!enabled || running}
                      >
                        {level}
                        <ChevronDownIcon className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="top" className="w-56" aria-describedby={hintId}>
                      <DropdownMenuLabel>{t('chat.effort.label')}</DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={chat.effort}
                        onValueChange={(next) => { chat.chooseEffort(next as AiEffort); }}
                      >
                        {EFFORTS.map((option) => (
                          <DropdownMenuRadioItem key={option} value={option}>
                            {t(`chat.effort.${option}`)}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <p id={hintId} className="px-2.5 pt-1 pb-1.5 text-caption">{t('chat.effort.hint')}</p>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    size="icon-sm"
                    className="rounded-full"
                    aria-label={t(running ? 'chat.stop' : 'chat.send')}
                    tooltip={{
                      label: t(running ? 'chat.stop' : 'chat.send'),
                      ...(running ? {} : { keys: ['Enter'] }),
                      side: 'top',
                      align: 'end',
                    }}
                    disabled={running ? false : !enabled || loading || text.trim() === ''}
                    onClick={running ? chat.stop : send}
                  >
                    {running ? <StopIcon className="size-4" /> : <SparklesIcon className="size-4" />}
                  </Button>
                </div>
              </div>
            </div>
              <div className="mx-5 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-b-[14px] bg-muted/45 px-3 pt-1 pb-1.5">
                {access.provider && (
                  <span className={trayItem}>
                    <ChatIcon className="size-3.5" />
                    {providerName(t, access.provider)}
                  </span>
                )}
                <span className={trayItem}>
                  <ImageIcon className="size-3.5" />
                  {t(refining ? 'chat.tray.thisBackground' : 'chat.tray.newBackground')}
                </span>
                {showNotKept && <span className={`${trayItem} basis-full`}>{t('chat.notKept')}</span>}
              </div>
          </div>
        )}
      </AiGate>
    </div>
  );
}

/** The AI chat of the editor: the conversation about the background, and the box to continue it. */
export function ChatPanel({ chat, onClose }: { chat: ChatController; onClose: () => void }) {
  const { t } = useTranslation();
  const { state } = chat;
  const { messages, run } = state;
  const listRef = useRef<HTMLDivElement>(null);
  // Whether the list follows new content; the user scrolling up lets go of it.
  const follow = useRef(true);

  const lastApplied = messages.findLastIndex(reachedCanvas);
  const actions: ReplyActions = {
    onUseResult: chat.useResult,
    onRegenerate: chat.regenerate,
    onSavePreset: chat.savePreset,
  };

  const running = run !== null;
  const stage = run?.stage;
  const streamed = run ? run.thinking.length + run.text.length + run.output.length : 0;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && follow.current) list.scrollTop = list.scrollHeight;
  }, [messages.length, running, streamed, stage]);

  return (
    <aside
      aria-label={t('chat.title')}
      className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl bg-panel"
    >
      <header className="flex h-12 shrink-0 items-center justify-between pr-2 pl-4">
        <h2 className="text-tab">{t('chat.title')}</h2>
        <Button variant="ghost" size="icon-sm" aria-label={t('chat.close')} title={t('chat.close')} onClick={onClose}>
          <CloseIcon />
        </Button>
      </header>
      {/* A log: finished messages are announced, the reply being written is not. */}
      <div
        ref={listRef}
        role="log"
        aria-label={t('chat.title')}
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3"
        onScroll={(event) => {
          const list = event.currentTarget;
          follow.current = list.scrollHeight - list.scrollTop - list.clientHeight <= STICK_PX;
        }}
      >
        {chat.loading && <p className="text-caption">{t('chat.loading')}</p>}
        {!chat.loading && messages.length === 0 && !run && (
          <p className="text-control-sm font-normal text-muted-foreground">{t('chat.emptyHint')}</p>
        )}
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <UserBubble key={message.id} text={message.text} />
          ) : (
            <AgentReply
              key={message.id}
              message={message}
              index={index}
              messages={messages}
              canvasSource={chat.canvasSource}
              latestApplied={index === lastApplied}
              busy={run !== null}
              actions={actions}
            />
          ),
        )}
        {run && (
          <>
            <UserBubble text={run.prompt} />
            {/* Keyed by run, so each run's log starts closed whatever the last one was. */}
            <RunningReply key={run.startedAt} run={run} onStop={chat.stop} />
          </>
        )}
      </div>
      {chat.notice && (
        <div className="shrink-0 px-3 pb-2">
          <ErrorNotice error={chat.notice} onDismiss={chat.dismissNotice} />
        </div>
      )}
      <Composer chat={chat} />
    </aside>
  );
}
