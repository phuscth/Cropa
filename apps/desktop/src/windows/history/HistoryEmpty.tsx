import { Button, CameraIcon, SettingsIcon } from '@cropa/ui';
import { useTranslation } from 'react-i18next';

interface HistoryEmptyProps {
  /** `empty`: nothing captured yet. `off`: saving to history is turned off. */
  kind: 'empty' | 'off';
  /** The capture shortcut, such as `Ctrl+Shift+S`; undefined until the settings are read. */
  shortcut: string | undefined;
  onCapture: () => void;
  onOpenSettings: () => void;
}

const KEY_NAMES: Record<string, string> = { PrintScreen: 'PrtScn' };

function Illustration({ kind }: { kind: 'empty' | 'off' }) {
  const bracket = 'stroke-foreground/35';
  return (
    <svg aria-hidden="true" viewBox="0 0 160 112" className="h-[112px] w-[160px]">
      <rect width="160" height="112" rx="24" className="fill-foreground/[0.04]" />
      <rect
        x="40"
        y="22"
        width="84"
        height="60"
        rx="10"
        opacity="0.7"
        transform="rotate(-8 82 52)"
        className="fill-popover"
      />
      <rect x="34" y="33" width="88" height="62" rx="10" className="fill-foreground/[0.06]" />
      <rect x="34" y="30" width="88" height="62" rx="10" className="fill-popover" />
      <g fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={bracket}>
        <path d="M46 51v-9h9" />
        <path d="M101 42h9v9" />
        <path d="M110 71v9h-9" />
        <path d="M55 80h-9v-9" />
      </g>
      <circle cx="118" cy="84" r="15" className="fill-primary" />
      <path
        d={kind === 'empty' ? 'M118 78v12M112 84h12' : 'M114 79v10M122 79v10'}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-primary-foreground"
      />
    </svg>
  );
}

/** What the History view shows with no captures to list. */
export function HistoryEmpty({ kind, shortcut, onCapture, onOpenSettings }: HistoryEmptyProps) {
  const { t } = useTranslation();
  const keys = shortcut?.split('+').filter((part) => part !== '').map((part) => KEY_NAMES[part] ?? part) ?? [];
  return (
    <div className="flex min-h-full animate-fade-in flex-col items-center justify-center gap-5 pb-10 text-center">
      <Illustration kind={kind} />
      <div className="flex flex-col items-center gap-1.5">
        <h2 className="text-[22px] leading-tight font-semibold tracking-[-0.03em]">
          {kind === 'empty' ? t('history.emptyTitle') : t('history.offTitle')}
        </h2>
        <p className="max-w-[340px] text-control-sm font-normal text-muted-foreground">
          {kind === 'empty' ? t('history.emptyCaption') : t('history.offCaption')}
        </p>
      </div>
      {kind === 'empty' ? (
        <>
          <Button data-history-primary="" onClick={onCapture}>
            <CameraIcon />
            {t('history.captureRegion')}
          </Button>
          {keys.length > 0 && (
            <p className="flex items-center gap-1.5 text-caption">
              {t('history.orPress')}
              {keys.map((key) => (
                <kbd
                  key={key}
                  className="flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-foreground/[0.07] px-1.5 font-sans text-[11px] leading-none font-semibold text-foreground"
                >
                  {key}
                </kbd>
              ))}
            </p>
          )}
        </>
      ) : (
        <Button data-history-primary="" onClick={onOpenSettings}>
          <SettingsIcon />
          {t('history.openSettings')}
        </Button>
      )}
    </div>
  );
}
