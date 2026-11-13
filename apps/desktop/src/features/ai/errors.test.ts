import { AGENT_ERROR_KINDS, TASK_ERROR_KINDS } from '@cropa/ai';
import { describe, expect, it } from 'vitest';

import en from '../../lib/i18n/en.json';
import vi from '../../lib/i18n/vi.json';

describe('AI error messages', () => {
  const kinds = [...AGENT_ERROR_KINDS, ...TASK_ERROR_KINDS];

  for (const [language, strings] of [['en', en], ['vi', vi]] as const) {
    it.each(kinds)(`${language} says what, why and what next for %s`, (kind) => {
      const message: Record<string, unknown> = strings.aiErrors[kind];
      for (const part of ['what', 'why', 'next']) {
        expect(typeof message[part]).toBe('string');
        expect(message[part]).not.toBe('');
      }
    });
  }
});
