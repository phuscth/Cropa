import { Button, SegmentedControl, SegmentedControlItem } from '@cropa/ui';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { AiEffort } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { AiGate } from '../ai/AiGate.tsx';
import { AgentReply, RunningReply, UserBubble, type ReplyActions } from './ChatParts.tsx';
import { reachedCanvas } from './chat-session.ts';
import type { ChatController } from './use-background-chat.ts';

const EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high'];
const MAX_MESSAGE_CHARS = 500;
/** The list follows new content while it is within this many pixels of the bottom. */
const STICK_PX = 32;

const textareaClass =
  'focus-ring max-h-32 min-h-[72px] w-full resize-none rounded-xl border border-input bg-card px-3 py-2 text-control-sm font-normal transition-[color,border-color,box-shadow] duration-150 ease-enter placeholder:text-tertiary-foreground hover:border-foreground/25 focus-visible:border-ring disabled:pointer-events-none disabled:opacity-50';

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

function Composer({ chat }: { chat: ChatController }) {
  const { t } = useTranslation();
  const fieldId = useId();
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

  return (
    <div className="flex shrink-0 flex-col gap-2 p-3 pt-1">
      <AiGate access={access}>
        {(enabled) => (
          <div className="flex w-full flex-col gap-2">
            <label htmlFor={fieldId} className="sr-only">
              {t('chat.messageLabel')}
            </label>
            <div className="relative">
              <textarea
                id={fieldId}
                rows={2}
                maxLength={MAX_MESSAGE_CHARS}
                value={text}
                disabled={!enabled || running || loading}
                placeholder={t(refining ? 'chat.placeholder.refine' : 'chat.placeholder.generate')}
                onChange={(event) => { setText(event.target.value); }}
                onKeyDown={onKeyDown}
                className={`${textareaClass} pr-12`}
              />
              <Button
                size="icon-sm"
                className="absolute right-2 bottom-2"
                aria-label={t(running ? 'chat.stop' : 'chat.send')}
                title={t(running ? 'chat.stop' : 'chat.send')}
                disabled={running ? false : !enabled || loading || text.trim() === ''}
                onClick={running ? chat.stop : send}
              >
                {running ? <StopIcon /> : <SendIcon />}
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-section">{t('chat.effort.label')}</span>
              <SegmentedControl
                aria-label={t('chat.effort.label')}
                value={chat.effort}
                disabled={!enabled || running}
                onValueChange={(next) => { chat.chooseEffort(next as AiEffort); }}
              >
                {EFFORTS.map((level) => (
                  <SegmentedControlItem key={level} value={level}>
                    {t(`chat.effort.${level}`)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              <p className="text-caption">{t('chat.effort.hint')}</p>
            </div>
            {refining && (
              <Button variant="ghost" size="sm" className="self-start" disabled={running} onClick={chat.startOver}>
                {t('chat.startOver')}
              </Button>
            )}
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
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3"
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
            <RunningReply run={run} onStop={chat.stop} />
          </>
        )}
      </div>
      {!chat.kept && !chat.loading && !chat.notice && (
        <p className="shrink-0 px-4 pb-2 text-caption">{t('chat.notKept')}</p>
      )}
      {chat.notice && (
        <div className="shrink-0 px-3 pb-2">
          <ErrorNotice error={chat.notice} onDismiss={chat.dismissNotice} />
        </div>
      )}
      <Composer chat={chat} />
    </aside>
  );
}
