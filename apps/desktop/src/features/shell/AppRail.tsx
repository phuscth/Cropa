import { EditorIcon, HistoryIcon, NavRail, NavRailItem, SettingsIcon } from '@cropa/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { MainView } from '../../lib/bindings.ts';

interface Props {
  /** The view on screen. */
  current: MainView;
  onSelect: (view: MainView) => void;
}

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
    <NavRail aria-label={t('rail.label')} footer={item('Settings', t('rail.settings'), <SettingsIcon />)}>
      {item('Editor', t('rail.editor'), <EditorIcon />)}
      {item('History', t('rail.history'), <HistoryIcon />)}
    </NavRail>
  );
}
