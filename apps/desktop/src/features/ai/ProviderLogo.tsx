import { AnthropicLogo, OpenAILogo, SparklesIcon } from '@cropa/ui';

import type { AiProvider } from '../../lib/bindings.ts';

/** The mark of the company behind a provider; the test provider has none. Sized by `className`. */
export function ProviderLogo({ provider, className }: { provider: AiProvider; className?: string }) {
  switch (provider) {
    case 'claude':
      return <AnthropicLogo {...(className ? { className } : {})} />;
    case 'codex':
      return <OpenAILogo {...(className ? { className } : {})} />;
    default:
      return <SparklesIcon {...(className ? { className } : {})} aria-hidden />;
  }
}
