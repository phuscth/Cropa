import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

import { initI18n } from './i18n/index.ts';

/** Shared bootstrap for every window entry: i18n first, then React. */
export async function mount(Root: ComponentType): Promise<void> {
  await initI18n();
  const container = document.getElementById('root');
  if (!container) throw new Error('#root is missing from the window HTML');
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
