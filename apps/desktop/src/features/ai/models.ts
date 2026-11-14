import { commands, type AiModel, type AiProvider } from '../../lib/bindings.ts';
import type { CliStatus } from './providers.ts';

/** A model a provider offers. The entry with an empty id stands for the CLI's own default. */
export type ModelEntry = AiModel;

/** The result of asking a provider for its models. */
export interface ModelList {
  models: ModelEntry[];
  /** The list could not be read, or it came back empty. */
  failed: boolean;
}

/** What the next message is sent with: a provider and a model, where `null` is the CLI's default. */
export interface ModelChoice {
  provider: AiProvider;
  model: string | null;
}

type ListCall = (provider: string) => ReturnType<typeof commands.aiListModels>;

const inFlight = new Map<string, Promise<ModelList>>();

/**
 * Asks a provider for its models. Callers that ask while a call for the same provider is running
 * share it. A failure is reported as an empty, failed list instead of an error: the provider is
 * then offered with its default model. `call` is for tests.
 */
export function listModels(provider: string, call: ListCall = commands.aiListModels): Promise<ModelList> {
  const running = inFlight.get(provider);
  if (running) return running;
  const started = call(provider)
    .then(
      (result): ModelList =>
        result.status === 'ok' && result.data.length > 0
          ? { models: result.data, failed: false }
          : { models: [], failed: true },
      (): ModelList => ({ models: [], failed: true }),
    )
    .finally(() => {
      if (inFlight.get(provider) === started) inFlight.delete(provider);
    });
  inFlight.set(provider, started);
  return started;
}

/** The models to show: the list, or one entry for the CLI's default when there is none. */
export function withFallback(list: ModelList, defaultName: string): ModelEntry[] {
  if (list.models.length > 0) return list.models;
  return [{ id: '', name: defaultName, description: '', isDefault: true, isNew: false }];
}

/** A model's name for a button or a reply header: "GPT-6.1-Sol" becomes "6.1 Sol". */
export function shortModelName(name: string): string {
  return name.replace(/^gpt-/i, '').replace(/-/g, ' ');
}

/**
 * Whether `entry` is what `choice` selects. No model selects the provider's default entry, which
 * is how a choice saved before models were named still reads.
 */
export function isSelected(entry: Pick<ModelEntry, 'id' | 'isDefault'>, choice: Pick<ModelChoice, 'model'>): boolean {
  return choice.model === entry.id || (choice.model === null && entry.isDefault);
}

/**
 * The choice that picking `entry` makes: its own id, so the run names the model. Only the
 * stand-in for a list that could not be read has no id and leaves the choice to the CLI.
 */
export function choiceFor(provider: AiProvider, entry: Pick<ModelEntry, 'id'>): ModelChoice {
  return { provider, model: entry.id === '' ? null : entry.id };
}

export interface ChoosableProvider {
  provider: AiProvider;
  status: CliStatus;
  /** `loading` until the list came back. */
  models: ModelEntry[] | 'loading';
}

/**
 * Where the first message of a session goes: the last choice when its provider is offered (and
 * the model still exists), else the first ready provider with its default, else the first
 * provider offered.
 */
export function initialChoice(
  providers: readonly ChoosableProvider[],
  last: { provider: AiProvider | null; model: string | null },
): ModelChoice | undefined {
  const remembered = providers.find((p) => p.provider === last.provider);
  if (remembered) {
    const known =
      last.model === null ||
      remembered.models === 'loading' ||
      remembered.models.some((entry) => entry.id === last.model);
    return { provider: remembered.provider, model: known ? last.model : null };
  }
  const first = providers.find((p) => p.status === 'ready') ?? providers[0];
  return first ? { provider: first.provider, model: null } : undefined;
}

/** The names of the models each provider offers, by id. */
export type ModelNames = Partial<Record<AiProvider, readonly Pick<ModelEntry, 'id' | 'name' | 'isDefault'>[]>>;

/**
 * A model as a reply header names it: the short name when the provider's list has it, else the id
 * as stored. No model is the provider's default entry when its list is known, else `defaultLabel`.
 */
export function modelLabel(
  names: ModelNames,
  provider: AiProvider,
  model: string | null | undefined,
  defaultLabel: string,
): string {
  const list = names[provider];
  if (model === null || model === undefined) {
    const standard = list?.find((candidate) => candidate.isDefault && candidate.id !== '');
    return standard ? shortModelName(standard.name) : defaultLabel;
  }
  const entry = list?.find((candidate) => candidate.id === model);
  return entry ? shortModelName(entry.name) : model;
}
