import { NavRail, NavRailItem } from '@cropa/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { MainView } from '../../lib/bindings.ts';

interface Props {
  /** The view on screen. */
  current: MainView;
  onSelect: (view: MainView) => void;
}

/** Solid 16px icons: 1.5px bars with square ends, drawn at 20px. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" fillRule="evenodd" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Two crop marks. */
const EDITOR_ICON = (
  <Icon>
    <path d="M4 1h1.5v9.5H15V12H4z" />
    <path d="M1 4h11v11h-1.5V5.5H1z" />
  </Icon>
);

/** A clock face with its hands. */
const HISTORY_ICON = (
  <Icon>
    <path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z" />
    <path d="M7.25 4h1.5v3.25H11v1.5H7.25z" />
  </Icon>
);

const GEAR_TEETH = [0, 45, 90, 135, 180, 225, 270, 315];

/** A gear: a ring with eight square teeth and a hub. */
const SETTINGS_ICON = (
  <Icon>
    <path d="M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
    <circle cx="8" cy="8" r="1.75" />
    {GEAR_TEETH.map((angle) => (
      <rect key={angle} x="7" y="0.75" width="2" height="2.5" transform={`rotate(${String(angle)} 8 8)`} />
    ))}
  </Icon>
);

/** The side rail of the main window: it switches between its views. */
export function AppRail({ current, onSelect }: Props) {
  const { t } = useTranslation();

  const item = (view: MainView, label: string, icon: ReactNode) => (
    <NavRailItem
      icon={icon}
      label={label}
      active={view === current}
      onClick={() => {
        onSelect(view);
      }}
    />
  );

  return (
    <NavRail
      aria-label={t('rail.label')}
      footer={item('Settings', t('rail.settings'), SETTINGS_ICON)}
    >
      {item('Editor', t('rail.editor'), EDITOR_ICON)}
      {item('History', t('rail.history'), HISTORY_ICON)}
    </NavRail>
  );
}
