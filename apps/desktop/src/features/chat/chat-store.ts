import { BackgroundSpec } from '@cropa/core';
import type { TFunction } from 'i18next';

import { commands, type ChatMessage_Serialize, type CommandError } from '../../lib/bindings.ts';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import type { ChatMessage } from './chat-session.ts';

/**
 * The messages as read from disk. Rust cannot check a background against the schema, so each one
 * is checked here; a message whose background does not pass keeps its text and loses only that.
 */
export function withValidBackgrounds(messages: readonly ChatMessage_Serialize[]): ChatMessage[] {
  return messages.map((message) => {
    const { background, ...rest } = message;
    if (background === undefined || background === null) return rest;
    const parsed = BackgroundSpec.safeParse(background);
    return parsed.success ? { ...rest, background: parsed.data } : rest;
  });
}

/** Why a read, a save or another command of the chat failed, kept until it is shown in a language. */
export type ChatFailure = { kind: 'command'; error: CommandError } | { kind: 'unexpected'; cause: unknown };

export function describeFailure(t: TFunction, failure: ChatFailure): UserError {
  return failure.kind === 'command' ? describeCommandError(t, failure.error) : describeUnexpected(t, failure.cause);
}

/** A failure from the result of a typed command. */
export function failureOf(result: { status: 'error'; error: CommandError }): ChatFailure {
  return { kind: 'command', error: result.error };
}

export interface ChatSaver {
  /** Saves a conversation after the ones queued before it. */
  save: (historyId: string, messages: readonly ChatMessage[]) => void;
  /** Resolves once everything queued so far has been written; never rejects. */
  settled: () => Promise<unknown>;
}

/**
 * Saves a conversation per call, one after the other, so an older conversation never lands after
 * a newer one. A failure is reported once through `onError`; `onNotKept` is called when Rust
 * wrote nothing because the capture is no longer in the history.
 */
export function createChatSaver(
  handlers: { onError: (failure: ChatFailure) => void; onNotKept: () => void },
  save: typeof commands.saveChat = commands.saveChat,
): ChatSaver {
  let last: Promise<unknown> = Promise.resolve();
  return {
    save: (historyId, messages) => {
      const list = [...messages];
      last = last.then(() =>
        save(historyId, list).then(
          (result) => {
            if (result.status === 'error') handlers.onError(failureOf(result));
            else if (!result.data) handlers.onNotKept();
          },
          (cause: unknown) => { handlers.onError({ kind: 'unexpected', cause }); },
        ),
      );
    },
    settled: () => last,
  };
}
