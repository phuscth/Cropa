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


/**
 * The annotation tools, a raised bar that floats at the bottom centre of the
 * canvas. Its corners are concentric with the buttons' (their radius plus the
 * 4px padding). It does not scroll, so the tooltips above it are not clipped; it
 * still fits the canvas at the window's minimum width with the sidebar and the
 * chat open. The tooltips of the end tools line up with the pill's edges so
 * the canvas does not clip them either.
 */
export function AnnotationToolbar({ tool, onTool, disabled }: Props) {
  const { t } = useTranslation();
  const last = TOOLS.length - 1;
  return (
    <nav
      aria-label={t('editor.annotate.toolbar')}
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-[calc(var(--radius-lg)+4px)] bg-card p-1 shadow-soft"
    >
      {TOOLS.map((name, index) => {
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
            tooltip={{
              label,
              keys: [TOOL_KEYS[name].key.toUpperCase()],
              side: 'top',
              align: index === 0 ? 'start' : index === last ? 'end' : 'center',
            }}
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
