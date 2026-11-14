import { Button, ModelPicker } from '@cropa/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type AiProvider, type CommandError } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { choiceFor, isSelected, shortModelName, withFallback } from '../ai/models.ts';
import { ProviderLogo } from '../ai/ProviderLogo.tsx';
import { providerName } from '../ai/providers.ts';
import type { ChatController } from './use-background-chat.ts';

/** What the picker shows for a provider that cannot be used yet, with the step that fixes it. */
function Unavailable({ chat, provider }: { chat: ChatController; provider: AiProvider }) {
  const { t } = useTranslation();
  const [error, setError] = useState<UserError>();
  const status = chat.providers.find((p) => p.provider === provider)?.status;
  const name = providerName(t, provider);
  const cli = provider === 'claude' || provider === 'codex' ? provider : undefined;
  const run = (call: () => Promise<{ status: 'ok'; data: unknown } | { status: 'error'; error: CommandError }>) => {
    setError(undefined);
    call().then(
      (result) => {
        if (result.status === 'error') setError(describeCommandError(t, result.error));
      },
      (cause: unknown) => { setError(describeUnexpected(t, cause)); },
    );
  };
  const text =
    status === 'notInstalled'
      ? t('chat.model.notInstalled', { provider: name })
      : status === 'notLoggedIn'
        ? t('chat.model.notLoggedIn', { provider: name })
        : t('chat.model.unavailable', { provider: name });
  return (
    <div className="flex flex-col items-center gap-3">
      <p>{text}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {cli && status === 'notInstalled' && (
          <Button variant="secondary" size="sm" onClick={() => { run(() => commands.openAiInstallGuide(cli)); }}>
            {t('ai.onboarding.installGuide')}
          </Button>
        )}
        {cli && status === 'notLoggedIn' && (
          <Button variant="secondary" size="sm" onClick={() => { run(() => commands.openLoginTerminal(cli)); }}>
            {t('ai.onboarding.login')}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={chat.recheckProviders}>
          {t('ai.onboarding.recheck')}
        </Button>
      </div>
      {error && <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />}
    </div>
  );
}

/** The composer's provider and model chooser, wired to the chat's providers, choice and favorites. */
export function ModelPickerControl({ chat, disabled }: { chat: ChatController; disabled: boolean }) {
  const { t } = useTranslation();
  const { providers, choice, favorites } = chat;
  const defaultName = t('chat.model.default');

  const entries = providers.flatMap((p) =>
    p.status === 'ready' && p.models !== 'loading'
      ? withFallback({ models: p.models, failed: p.listFailed }, defaultName).map((entry) => ({
          provider: p.provider,
          entry,
        }))
      : [],
  );
  const models = entries.map(({ provider, entry }) => ({
    provider,
    id: entry.id,
    name: entry.name,
    isNew: entry.isNew,
    favorite: favorites.some((f) => f.provider === provider && f.model === entry.id),
    // The stand-in for an unreadable list has no model name to keep.
    favoritable: entry.id !== '',
  }));
  const selected = choice && entries.find((e) => e.provider === choice.provider && isSelected(e.entry, choice));
  const triggerLabel = selected
    ? shortModelName(selected.entry.name)
    : choice
      ? providerName(t, choice.provider)
      : defaultName;
  const failed = providers.filter((p) => p.status === 'ready' && p.listFailed).map((p) => providerName(t, p.provider));

  return (
    <ModelPicker
      providers={providers.map((p) => ({
        id: p.provider,
        label: providerName(t, p.provider),
        logo: <ProviderLogo provider={p.provider} className="size-4" />,
        ...(p.status === 'ready' ? {} : { unavailable: <Unavailable chat={chat} provider={p.provider} /> }),
      }))}
      models={models}
      value={selected ? { provider: selected.provider, id: selected.entry.id } : null}
      onChange={(provider, id) => {
        const entry = entries.find((e) => e.provider === provider && e.entry.id === id);
        if (entry) chat.chooseModel(entry.provider, choiceFor(entry.provider, entry.entry).model);
      }}
      onToggleFavorite={(provider, id) => { chat.toggleFavorite(provider as AiProvider, id); }}
      triggerLabel={triggerLabel}
      triggerLogo={choice ? <ProviderLogo provider={choice.provider} className="size-4" /> : null}
      disabled={disabled || providers.length === 0}
      notice={failed.length > 0 ? t('chat.model.listFailed', { provider: failed.join(', ') }) : undefined}
      labels={{
        trigger: t('chat.model.picker', { model: triggerLabel }),
        search: t('chat.model.search'),
        favorites: t('chat.model.favorites'),
        addFavorite: (name) => t('chat.model.addFavorite', { model: name }),
        removeFavorite: (name) => t('chat.model.removeFavorite', { model: name }),
        newBadge: t('chat.model.new'),
        noFavorites: t('chat.model.noFavorites'),
        noMatch: (query) => t('chat.model.noMatch', { query }),
      }}
    />
  );
}
