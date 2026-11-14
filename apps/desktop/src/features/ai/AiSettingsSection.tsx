import { paletteNameTask, runTask, type AgentErrorKind, type Capability } from '@cropa/ai';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@cropa/ui';
import type { TFunction } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  commands,
  type AiErrorKind as MockErrorKind,
  type AiMockScript_Deserialize,
  type AiProvider,
  type CommandError,
  type Settings,
} from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { SettingRow, SettingsSection } from '../settings/SettingsLayout.tsx';
import { aiAccess } from './access.ts';
import { AiProviderList } from './AiProviderList.tsx';
import { describeAiError } from './errors.ts';
import { capabilitiesOf, providerName } from './providers.ts';
import { createDesktopTransport } from './transport.ts';
import { useDetection } from './use-ai-providers.ts';

const TEST_COLORS = ['#1e3a8a', '#f59e0b', '#f8fafc'];
const TEST_TIMEOUT_MS = 60_000;

/** What the mock provider does in a connection test: succeed, answer badly, or fail like a CLI. */
const MOCK_FAILURES: readonly (readonly [AgentErrorKind, MockErrorKind])[] = [
  ['NotInstalled', 'notInstalled'],
  ['NotLoggedIn', 'notLoggedIn'],
  ['UsageLimit', 'usageLimit'],
  ['Unsupported', 'unsupported'],
  ['Timeout', 'timeout'],
  ['Protocol', 'protocol'],
  ['Cancelled', 'cancelled'],
];

function mockScript(choice: string): AiMockScript_Deserialize {
  const base = {
    delayMs: 1500,
    events: [{ kind: 'delta' as const, text: '…' }],
    result: null,
    error: null,
  };
  if (choice === 'success') return { ...base, result: { name: 'Quiet Harbour', mood: 'calm' } };
  // Two malformed answers in a row: the retry fails too, so the task reports InvalidOutput.
  if (choice === 'malformed') return { ...base, result: {} };
  const failure = MOCK_FAILURES.find(([kind]) => kind === choice);
  return { ...base, error: failure?.[1] ?? null };
}

type TestState =
  | { kind: 'running' }
  | { kind: 'passed'; name: string; mood: string; seconds: string }
  | { kind: 'failed'; error: UserError };

/** Runs the palette-naming task through a provider with its default model; undefined when cancelled. */
async function testProvider(
  provider: AiProvider,
  capabilities: Capability[],
  script: AiMockScript_Deserialize | null,
  signal: AbortSignal,
  t: TFunction,
): Promise<TestState | undefined> {
  const started = performance.now();
  const outcome = await runTask(
    paletteNameTask,
    { colors: TEST_COLORS },
    {
      transport: createDesktopTransport({ provider, model: null }, {}, script),
      provider: { name: provider, capabilities },
      signal,
      timeoutMs: TEST_TIMEOUT_MS,
    },
  ).done;
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (outcome.source === 'ai') return { kind: 'passed', ...outcome.result, seconds };
  if (signal.aborted) return undefined;
  return { kind: 'failed', error: describeAiError(t, outcome.notice?.kind ?? 'Protocol', providerName(t, provider)) };
}

interface Props {
  settings: Settings | undefined;
  onSettings: (settings: Settings) => void;
}

/** Settings → AI: each provider and what it needs, a connection test per provider, sending images and what AI use means. */
export function AiSettingsSection({ settings, onSettings }: Props) {
  const { t } = useTranslation();
  const access = aiAccess(settings);
  const { listed, rechecking, recheck } = useDetection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError>();
  // The last result of each provider's test; one test runs at a time.
  const [tests, setTests] = useState<Partial<Record<AiProvider, TestState | undefined>>>({});
  const [mockChoice, setMockChoice] = useState('success');
  const controller = useRef<AbortController>(undefined);
  const testRunning = Object.values(tests).some((test) => test?.kind === 'running');

  // A running test is cancelled when this section unmounts.
  useEffect(() => () => { controller.current?.abort(); }, []);

  // Closing the window only hides it, so cancel a running test when it is hidden.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') controller.current?.abort();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  const save = async (
    call: () => Promise<
      { status: 'ok'; data: Settings } | { status: 'error'; error: CommandError }
    >,
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await call();
      if (result.status === 'error') setError(describeCommandError(t, result.error));
      else onSettings(result.data);
    } catch (cause) {
      setError(describeUnexpected(t, cause));
    } finally {
      setBusy(false);
    }
  };

  const setTest = (provider: AiProvider, test: TestState | undefined) => {
    setTests((before) => ({ ...before, [provider]: test }));
  };

  const runTest = async (provider: AiProvider) => {
    const found = listed?.find((item) => item.provider === provider);
    if (!found) return;
    const abort = new AbortController();
    controller.current = abort;
    setTest(provider, { kind: 'running' });
    const script = import.meta.env.DEV && provider === 'mock' ? mockScript(mockChoice) : null;
    setTest(provider, await testProvider(provider, capabilitiesOf(found.detection), script, abort.signal, t));
  };

  return (
    <SettingsSection title={t('ai.settings.title')}>
      {error && (
        <div className="px-5 py-4">
          <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />
        </div>
      )}

      <div className="px-5 py-4">
        <AiProviderList
          listed={listed}
          recheck={recheck}
          rechecking={rechecking}
          disabled={testRunning}
          actions={({ provider }, status) =>
            status === 'ready' && (
              <Button
                variant="secondary"
                size="sm"
                disabled={testRunning || busy}
                onClick={() => { void runTest(provider); }}
              >
                {t('ai.test.button')}
              </Button>
            )
          }
          below={({ provider }) => {
            const test = tests[provider];
            const mock = import.meta.env.DEV && provider === 'mock';
            if (!test && !mock) return null;
            return (
              <div className="flex flex-col items-start gap-2 pl-8">
                {mock && (
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <span id="ai-mock-result">{t('ai.test.mockResult')}</span>
                    <Select value={mockChoice} disabled={testRunning} onValueChange={setMockChoice}>
                      <SelectTrigger aria-labelledby="ai-mock-result" className="w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="success">{t('ai.test.mockSuccess')}</SelectItem>
                        <SelectItem value="malformed">{t('ai.test.mockMalformed')}</SelectItem>
                        {MOCK_FAILURES.map(([kind]) => (
                          <SelectItem key={kind} value={kind}>
                            {t(`aiErrors.${kind}.what`, { provider: providerName(t, provider) })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {test?.kind === 'running' && (
                  <div className="flex items-center gap-3">
                    <span role="status" className="text-sm text-muted-foreground">
                      {t('ai.test.running')}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => { controller.current?.abort(); }}>
                      {t('ai.test.cancel')}
                    </Button>
                  </div>
                )}
                {test?.kind === 'passed' && (
                  <p role="status" className="text-sm">
                    {t('ai.test.passed', test)}
                  </p>
                )}
                {test?.kind === 'failed' && <ErrorNotice error={test.error} />}
              </div>
            );
          }}
        />
      </div>

      <SettingRow
        label={t('ai.settings.allowImages')}
        description={t('ai.settings.allowImagesHint')}
      >
        {({ labelId, descriptionId }) => (
          <Switch
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            checked={access.allowImages}
            disabled={busy || !settings}
            onCheckedChange={(enabled) => { void save(() => commands.setAiAllowImages(enabled)); }}
          />
        )}
      </SettingRow>

      <p className="px-5 py-4 text-sm text-muted-foreground">{t('ai.settings.privacy')}</p>
    </SettingsSection>
  );
}
