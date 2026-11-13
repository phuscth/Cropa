import { NavRail, NavRailItem } from '@cropa/ui';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type AppWindow } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';

interface Props {
  /** The window this rail is in. */
  current: AppWindow;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const EDITOR_ICON = (
  <Icon>
    <path d="M6 2.5v11a1 1 0 0 0 1 1h10.5M2.5 6H13a1 1 0 0 1 1 1v10.5" />
  </Icon>
);

const HISTORY_ICON = (
  <Icon>
    <path d="M3 10a7 7 0 1 0 2.2-5.1M3 3.5v3h3M10 6.5V10l2.5 1.5" />
  </Icon>
);

const SETTINGS_ICON = (
  <Icon>
    <path d="M3 6h8M15 6h2M3 14h2M9 14h8" />
    <circle cx="13" cy="6" r="2" />
    <circle cx="7" cy="14" r="2" />
  </Icon>
);

/** The Cropa mark: two crop corners around a pink square. */
function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-8" fill="none" aria-hidden="true">
      <path
        d="M9 3v16a4 4 0 0 0 4 4h16M3 9h16a4 4 0 0 1 4 4v16"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-foreground"
      />
      <rect x="13" y="13" width="6" height="6" rx="1.5" className="fill-primary" />
    </svg>
  );
}

/** The side rail shared by the editor, history and settings windows. */
export function AppRail({ current }: Props) {
  const { t } = useTranslation();
  // Shown as a floating notice when another window could not be opened.
  const [error, setError] = useState<UserError>();

  const open = async (window: AppWindow) => {
    try {
      const result = await commands.openWindow(window);
      if (result.status === 'error') setError(describeCommandError(t, result.error));
      else setError(undefined);
    } catch (cause) {
      setError(describeUnexpected(t, cause));
    }
  };

  const item = (window: AppWindow, label: string, icon: ReactNode) => (
    <NavRailItem
      icon={icon}
      label={label}
      active={window === current}
      onClick={() => {
        if (window !== current) void open(window);
      }}
    />
  );

  return (
    <>
      <NavRail
        aria-label={t('rail.label')}
        logo={<Logo />}
        footer={item('Settings', t('rail.settings'), SETTINGS_ICON)}
      >
        {item('Editor', t('rail.editor'), EDITOR_ICON)}
        {item('History', t('rail.history'), HISTORY_ICON)}
      </NavRail>
      {error && (
        <div className="fixed bottom-4 left-28 z-50 w-80 max-w-[calc(100vw-8rem)] shadow-lg">
          <ErrorNotice
            error={error}
            onDismiss={() => {
              setError(undefined);
            }}
          />
        </div>
      )}
    </>
  );
}
