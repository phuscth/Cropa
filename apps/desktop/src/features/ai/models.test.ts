import { describe, expect, it, vi } from 'vitest';

import type { AiModel } from '../../lib/bindings.ts';
import {
  choiceFor,
  initialChoice,
  isSelected,
  listModels,
  shortModelName,
  modelLabel,
  withFallback,
  type ChoosableProvider,
} from './models.ts';

const sol: AiModel = { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: '', isDefault: true, isNew: true };
const terra: AiModel = { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', description: '', isDefault: false, isNew: false };

describe('shortModelName', () => {
  it('drops a leading GPT and turns dashes into spaces', () => {
    expect(shortModelName('GPT-6.1-Sol')).toBe('6.1 Sol');
    expect(shortModelName('gpt-6.1 Terra')).toBe('6.1 Terra');
    expect(shortModelName('Opus 5.5')).toBe('Opus 5.5');
  });
});

describe('isSelected', () => {
  it('matches the model by id, and the default entry when no model is chosen', () => {
    expect(isSelected(terra, { model: 'gpt-6.1-terra' })).toBe(true);
    expect(isSelected(terra, { model: null })).toBe(false);
    expect(isSelected(sol, { model: null })).toBe(true);
    expect(isSelected(sol, { model: 'gpt-6.1-terra' })).toBe(false);
  });

  it('stores the id of any real entry, and no model for the stand-in of an unreadable list', () => {
    expect(choiceFor('codex', sol)).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' });
    expect(choiceFor('codex', terra)).toEqual({ provider: 'codex', model: 'gpt-6.1-terra' });
    const [standIn] = withFallback({ models: [], failed: true }, 'Default');
    expect(standIn && choiceFor('codex', standIn)).toEqual({ provider: 'codex', model: null });
  });
});

describe('listModels', () => {
  it('shares a running call per provider', async () => {
    const call = vi.fn(() => Promise.resolve({ status: 'ok' as const, data: [sol] }));
    const [a, b] = await Promise.all([listModels('share-a', call), listModels('share-a', call)]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    await listModels('share-a', call);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('reports an error, a rejection and an empty list as a failed, empty list', async () => {
    const error = () => Promise.resolve({ status: 'error' as const, error: { kind: 'Unsupported' as const } });
    const empty = () => Promise.resolve({ status: 'ok' as const, data: [] });
    const rejected = () => Promise.reject(new Error('ipc'));
    for (const [name, call] of [['err', error], ['empty', empty], ['rej', rejected]] as const) {
      await expect(listModels(`fail-${name}`, call)).resolves.toEqual({ models: [], failed: true });
    }
  });
});

describe('withFallback', () => {
  it('offers the CLI default when the list is empty, and the list otherwise', () => {
    expect(withFallback({ models: [], failed: true }, 'Default')).toEqual([
      { id: '', name: 'Default', description: '', isDefault: true, isNew: false },
    ]);
    expect(withFallback({ models: [sol, terra], failed: false }, 'Default')).toEqual([sol, terra]);
  });
});

describe('initialChoice', () => {
  const claude: ChoosableProvider = { provider: 'claude', status: 'notInstalled', models: [] };
  const codex: ChoosableProvider = { provider: 'codex', status: 'ready', models: [sol, terra] };

  it('returns the last choice when its provider is offered', () => {
    expect(initialChoice([claude, codex], { provider: 'codex', model: 'gpt-6.1-terra' })).toEqual({
      provider: 'codex',
      model: 'gpt-6.1-terra',
    });
  });

  it('falls back to the CLI default when the remembered model is gone', () => {
    expect(initialChoice([codex], { provider: 'codex', model: 'retired' })).toEqual({ provider: 'codex', model: null });
  });

  it('else takes the first ready provider, then the first one offered', () => {
    expect(initialChoice([claude, codex], { provider: null, model: null })).toEqual({ provider: 'codex', model: null });
    expect(initialChoice([claude], { provider: 'mock', model: null })).toEqual({ provider: 'claude', model: null });
    expect(initialChoice([], { provider: null, model: null })).toBeUndefined();
  });
});

describe('modelLabel', () => {
  const names = { codex: [sol, terra] };

  it('names a model by its short name, or by its id when the list lacks it', () => {
    expect(modelLabel(names, 'codex', 'gpt-6.1-terra', 'Default')).toBe('6.1 Terra');
    expect(modelLabel(names, 'codex', 'retired', 'Default')).toBe('retired');
  });

  it('shows the default entry for a reply with no model, and Default when the list is unknown', () => {
    expect(modelLabel(names, 'codex', null, 'Default')).toBe('6.1 Sol');
    expect(modelLabel(names, 'codex', undefined, 'Default')).toBe('6.1 Sol');
    expect(modelLabel(names, 'claude', null, 'Default')).toBe('Default');
  });
});
