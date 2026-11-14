import {
  ArrowToolIcon,
  BlurToolIcon,
  Button,
  PixelateToolIcon,
  RectToolIcon,
  SelectToolIcon,
  StepToolIcon,
  TextToolIcon,
  cn,
} from '@cropa/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { TOOL_KEYS, TOOLS, type Tool } from './tools.ts';

interface Props {
  tool: Tool;
  onTool: (tool: Tool) => void;
  disabled: boolean;
}
const ICONS: Record<Tool, ReactNode> = {
  select: <SelectToolIcon />,
  arrow: <ArrowToolIcon />,
  rect: <RectToolIcon />,
  text: <TextToolIcon />,
  step: <StepToolIcon />,
  blur: <BlurToolIcon />,
  pixelate: <PixelateToolIcon />,
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
