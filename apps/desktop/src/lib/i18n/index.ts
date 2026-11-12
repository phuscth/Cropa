import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './en.json';
import vi from './vi.json';

export const SUPPORTED_LANGUAGES = ['en', 'vi'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Pick a UI language from BCP 47 tags (e.g. `navigator.languages`). */
export function pickLanguage(tags: readonly string[]): Language {
  for (const tag of tags) {
    const primary = tag.toLowerCase().split(/[-_]/)[0];
    const match = SUPPORTED_LANGUAGES.find((lang) => lang === primary);
    if (match) return match;
  }
  return 'en';
}

export const resources = { en: { translation: en }, vi: { translation: vi } } as const;

export async function initI18n(): Promise<void> {
  await i18next.use(initReactI18next).init({
    resources,
    lng: pickLanguage(navigator.languages),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
  document.documentElement.lang = i18next.language;
}
