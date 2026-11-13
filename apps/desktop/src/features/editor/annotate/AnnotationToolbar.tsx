import { Button, cn } from '@cropa/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { TOOL_KEYS, TOOLS, type Tool } from './tools.ts';

interface Props {
  tool: Tool;
  onTool: (tool: Tool) => void;
  disabled: boolean;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const ICONS: Record<Tool, ReactNode> = {
  select: (
    <Icon>
      <path d="m3.5 2.5 8 4-3.5 1.2L6.8 11.5z" />
    </Icon>
  ),
  arrow: (
    <Icon>
      <path d="M3 13 13 3M6.5 3H13v6.5" />
    </Icon>
  ),
  rect: (
    <Icon>
      <rect x="3" y="3.5" width="10" height="9" rx="1" />
    </Icon>
  ),
  text: (
    <Icon>
      <path d="M3.5 4.5v-1h9v1M8 3.5v9M6 12.5h4" />
    </Icon>
  ),
  step: (
    <Icon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M7 6.5 8.2 5.8v4.4" />
    </Icon>
  ),
  blur: (
    <Icon>
      <path d="M8 2.5s4 4 4 7a4 4 0 0 1-8 0c0-3 4-7 4-7z" />
    </Icon>
  ),
  pixelate: (
    <Icon>
      <rect x="3" y="3" width="10" height="10" />
      <path d="M8 3v10M3 8h10" />
    </Icon>
  ),
};

/** The annotation tools, a raised pill that floats at the bottom centre of the canvas. */
export function AnnotationToolbar({ tool, onTool, disabled }: Props) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t('editor.annotate.toolbar')}
      className="absolute bottom-3 left-1/2 z-10 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-full bg-card p-1 shadow-soft"
    >
      {TOOLS.map((name) => {
        const label = t(`editor.annotate.tools.${name}`);
        return (
          <Button
            key={name}
            variant="ghost"
            size="icon-sm"
            className={cn(
              tool === name &&
                'bg-highlight/15 text-highlight hover:bg-highlight/20 hover:text-highlight',
            )}
            aria-label={label}
            aria-pressed={tool === name}
            title={`${label} (${TOOL_KEYS[name].key.toUpperCase()})`}
            disabled={disabled}
            onClick={() => { onTool(name); }}
          >
            {ICONS[name]}
          </Button>
        );
      })}
    </nav>
  );
}
