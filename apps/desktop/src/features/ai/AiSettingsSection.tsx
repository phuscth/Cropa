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
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  commands,
  type AiErrorKind as MockErrorKind,
  type AiMockScript_Deserialize,
  type CommandError,
  type Settings,
} from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { SettingRow, SettingsSection } from '../settings/SettingsLayout.tsx';
import { aiAccess } from './access.ts';
import { AiGate } from './AiGate.tsx';
import { AiOnboarding } from './AiOnboarding.tsx';
import { detectProviders } from './detect.ts';
import { describeAiError } from './errors.ts';
import { capabilitiesOf, providerName } from './providers.ts';
import { createDesktopTransport } from './transport.ts';

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
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'passed'; name: string; mood: string; seconds: string }
  | { kind: 'failed'; error: UserError };

interface Props {
  settings: Settings | undefined;
  onSettings: (settings: Settings) => void;
}

/** Settings → AI: the provider, sending images, a connection test and what AI use means. */
export function AiSettingsSection({ settings, onSettings }: Props) {
  const { t } = useTranslation();
  const access = aiAccess(settings);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError>();
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [mockChoice, setMockChoice] = useState('success');
  const controller = useRef<AbortController>(undefined);

  const provider = access.provider;
  const testRunning = test.kind === 'running';

  // The provider changed: close the change panel and forget the last test result.
  const [seenProvider, setSeenProvider] = useState(provider);
  if (seenProvider !== provider) {
    setSeenProvider(provider);
    setChoosing(false);
    setTest({ kind: 'idle' });
  }

  // A running test is cancelled when the provider changes or this section unmounts.
  useEffect(() => () => { controller.current?.abort(); }, [provider]);

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

  const name = provider ? providerName(t, provider) : '';

  const runTest = async () => {
    if (!provider) return;
    const abort = new AbortController();
    controller.current = abort;
    setTest({ kind: 'running' });

    let capabilities: Capability[] = [];
    try {
      const found = await detectProviders();
      const detection = found.find((d) => d.provider === provider);
      if (detection) capabilities = capabilitiesOf(detection);
    } catch {
      // The run itself reports what is wrong.
    }
    const script = import.meta.env.DEV && provider === 'mock' ? mockScript(mockChoice) : null;
    const started = performance.now();
    const outcome = await runTask(
      paletteNameTask,
      { colors: TEST_COLORS },
      {
        transport: createDesktopTransport(provider, {}, script),
        provider: { name: provider, capabilities },
        signal: abort.signal,
        timeoutMs: TEST_TIMEOUT_MS,
      },
    ).done;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);

    if (outcome.source === 'ai') {
      setTest({ kind: 'passed', ...outcome.result, seconds });
    } else if (abort.signal.aborted) {
      setTest({ kind: 'idle' });
    } else {
      const kind = outcome.notice?.kind ?? 'Protocol';
      setTest({ kind: 'failed', error: describeAiError(t, kind, name) });
    }
  };

  return (
    <SettingsSection title={t('ai.settings.title')}>
      {error && (
        <div className="px-5 py-4">
          <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />
        </div>
      )}

      <SettingRow
        label={t('ai.settings.provider')}
        description={provider ? name : t('ai.settings.notSetUp')}
        stacked={choosing}
      >
        {choosing ? (
          <AiOnboarding
            mode="change"
            onSaved={(next) => {
              setChoosing(false);
              onSettings(next);
            }}
            onCancel={() => { setChoosing(false); }}
          />
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || testRunning}
              onClick={() => { setChoosing(true); }}
            >
              {provider ? t('ai.settings.change') : t('ai.settings.setUp')}
            </Button>
            {provider && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || testRunning}
                onClick={() => { void save(() => commands.setAiProvider(null)); }}
              >
                {t('ai.settings.turnOff')}
              </Button>
            )}
          </>
        )}
      </SettingRow>

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

      <div className="px-5 py-4">
        <AiGate
          access={access}
          onSetUp={() => { setChoosing(true); }}
        >
          {(enabled) => (
            <div className="flex flex-col items-start gap-3">
              {import.meta.env.DEV && provider === 'mock' && (
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <span id="ai-mock-result">{t('ai.test.mockResult')}</span>
                  <Select
                    value={mockChoice}
                    disabled={test.kind === 'running'}
                    onValueChange={setMockChoice}
                  >
                    <SelectTrigger aria-labelledby="ai-mock-result" className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="success">{t('ai.test.mockSuccess')}</SelectItem>
                      <SelectItem value="malformed">{t('ai.test.mockMalformed')}</SelectItem>
                      {MOCK_FAILURES.map(([kind]) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`aiErrors.${kind}.what`, { provider: name })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {test.kind === 'running' ? (
                <div className="flex items-center gap-3">
                  <span role="status" className="text-sm text-muted-foreground">
                    {t('ai.test.running')}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => { controller.current?.abort(); }}>
                    {t('ai.test.cancel')}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!enabled || busy}
                  onClick={() => { void runTest(); }}
                >
                  {t('ai.test.button')}
                </Button>
              )}
              {test.kind === 'passed' && (
                <p role="status" className="text-sm">
                  {t('ai.test.passed', test)}
                </p>
              )}
              {test.kind === 'failed' && <ErrorNotice error={test.error} />}
            </div>
          )}
        </AiGate>
      </div>

      <p className="px-5 py-4 text-sm text-muted-foreground">{t('ai.settings.privacy')}</p>
    </SettingsSection>
  );
}
