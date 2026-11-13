import { PLATFORM_IDS, PLATFORM_SIZES, outputSize, type PlatformId } from '@cropa/core';
import {
  Button,
  DetailsCard,
  DetailsRow,
  SegmentedControl,
  SegmentedControlItem,
  Tile,
  TileGroup,
} from '@cropa/ui';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import type { ExportFormat } from '../../lib/bindings.ts';
import { exportPlan, resolutionLabel, type ExportScale } from './export/plan.ts';
import { AutoThumb, CustomThumb, RatioField, RatioThumb, SliderRow } from './panel-parts.tsx';
import {
  ASPECT_PRESETS,
  aspectPreset,
  frameRanges,
  platformMatches,
  presetRatio,
  setAspectRatio,
  setInset,
  setPadding,
  setPlatformSize,
  type AspectPreset,
} from './scene-edits.ts';
import { Section } from './Section.tsx';
import type { SceneHistory } from './use-scene-history.ts';

const FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'webp'];
const SCALES: readonly ExportScale[] = [1, 2, 3];

interface Props {
  history: Pick<SceneHistory, 'scene' | 'edit' | 'preview' | 'commit'>;
  /** The screenshot's size in pixels. */
  imageSize: { width: number; height: number };
  format: ExportFormat;
  onFormat: (format: ExportFormat) => void;
  scale: ExportScale;
  onScale: (scale: ExportScale) => void;
  /** An export is running. */
  busy: boolean;
  /** Opens the native save dialog with the format and scale chosen here. */
  onSaveAs: () => void;
  /** Pointer handlers of the drag-to-export handle. */
  dragHandlers: Pick<
    ComponentProps<'button'>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture'
  >;
}

function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="3.5" r="1.25" />
      <circle cx="10.5" cy="3.5" r="1.25" />
      <circle cx="5.5" cy="8" r="1.25" />
      <circle cx="10.5" cy="8" r="1.25" />
      <circle cx="5.5" cy="12.5" r="1.25" />
      <circle cx="10.5" cy="12.5" r="1.25" />
    </svg>
  );
}

/** The editor's right panel: the layout of the output (ratio, platform, spacing), then the export. */
export function LayoutPanel({
  history,
  imageSize,
  format,
  onFormat,
  scale,
  onScale,
  busy,
  onSaveAs,
  dragHandlers,
}: Props) {
  const { t } = useTranslation();
  const { scene, edit, preview, commit } = history;
  const { frame } = scene;
  const ranges = frameRanges(scene.screenshot);
  const preset = aspectPreset(scene);
  const ratio = scene.output.aspectRatio;
  // Facebook and Threads share a size, so the scene alone can't say which was clicked.
  const [lastPlatform, setLastPlatform] = useState<PlatformId>();
  const platform =
    lastPlatform && platformMatches(scene, lastPlatform)
      ? lastPlatform
      : PLATFORM_IDS.find((id) => platformMatches(scene, id));

  const chooseAspect = (value: string) => {
    const choice = value as AspectPreset;
    if (choice === 'custom') {
      if (preset === 'custom') return;
      // Start from the ratio the image has now, so choosing Custom changes nothing visible.
      const size = outputSize(scene, 1);
      const current = Math.round((size.width / size.height) * 100) / 100;
      edit((s) => setAspectRatio(s, [Math.min(100, Math.max(0.01, current)), 1]));
    } else {
      edit((s) => setAspectRatio(s, presetRatio(choice)));
    }
  };

  const choosePlatform = (value: string) => {
    const id = value as PlatformId;
    setLastPlatform(id);
    edit((s) => setPlatformSize(s, id));
  };

  const px = (value: number) => t('editor.units.px', { value });
  const scaleFixed = scene.output.width !== null;
  const plan = exportPlan(scene, format, scale);
  const size = (box: { width: number; height: number }) => t('editor.details.size', box);

  return (
    <aside
      aria-label={t('editor.layout.label')}
      className="flex w-[248px] shrink-0 flex-col overflow-hidden rounded-2xl bg-panel"
    >
      <h2 className="text-tab flex h-[52px] shrink-0 items-center px-4">{t('editor.layout.title')}</h2>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3 pt-1">
        <Section title={t('editor.aspect.title')}>
          <TileGroup
            aria-label={t('editor.aspect.title')}
            value={platform ? undefined : preset}
            onValueChange={chooseAspect}
          >
            {ASPECT_PRESETS.map((p) => (
              <Tile key={p} value={p} label={p === 'auto' || p === 'custom' ? t(`editor.aspect.${p}`) : p}>
                {p === 'auto' ? (
                  <AutoThumb />
                ) : p === 'custom' ? (
                  <CustomThumb />
                ) : (
                  <RatioThumb ratio={presetRatio(p) ?? [1, 1]} />
                )}
              </Tile>
            ))}
          </TileGroup>
          {!platform && preset === 'custom' && ratio && (
            <div className="flex items-center gap-2">
              <RatioField
                label={t('editor.aspect.width')}
                value={ratio[0]}
                onCommit={(w) => { edit((s) => setAspectRatio(s, [w, s.output.aspectRatio?.[1] ?? 1])); }}
              />
              <span aria-hidden="true">:</span>
              <RatioField
                label={t('editor.aspect.height')}
                value={ratio[1]}
                onCommit={(h) => { edit((s) => setAspectRatio(s, [s.output.aspectRatio?.[0] ?? 1, h])); }}
              />
            </div>
          )}
        </Section>

        <Section title={t('editor.aspect.platform.title')}>
          <TileGroup
            aria-label={t('editor.aspect.platform.title')}
            value={platform}
            onValueChange={choosePlatform}
          >
            {PLATFORM_IDS.map((id) => (
              <Tile key={id} value={id} label={t(`editor.aspect.platform.${id}`)}>
                <RatioThumb ratio={PLATFORM_SIZES[id].aspect} />
              </Tile>
            ))}
          </TileGroup>
          {platform && (
            <p className="text-caption tabular-nums">
              {t('editor.aspect.platform.size', {
                width: PLATFORM_SIZES[platform].width,
                height: PLATFORM_SIZES[platform].height,
              })}
            </p>
          )}
        </Section>

        <Section title={t('editor.layout.spacing')}>
          <div className="flex flex-col gap-2.5">
            <SliderRow
              label={t('editor.frame.padding')}
              value={px(frame.padding)}
              current={frame.padding}
              range={ranges.padding}
              onPreview={(next) => { preview((s) => setPadding(s, next)); }}
              onCommit={commit}
            />
            <SliderRow
              label={t('editor.frame.inset')}
              value={px(frame.inset)}
              current={frame.inset}
              range={ranges.inset}
              onPreview={(next) => { preview((s) => setInset(s, next)); }}
              onCommit={commit}
            />
          </div>
        </Section>

        <div className="mt-auto"><Section title={t('editor.export.title')}>
          <div className="flex flex-col gap-2.5">
            <p className="text-caption">{t('editor.export.saveAsOptions')}</p>
            <SegmentedControl
              aria-label={t('editor.export.saveAsFormat')}
              value={format}
              onValueChange={(next) => { onFormat(next as ExportFormat); }}
            >
              {FORMATS.map((f) => (
                <SegmentedControlItem key={f} value={f}>
                  {f.toUpperCase()}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <SegmentedControl
              aria-label={t('editor.export.saveAsScale')}
              value={String(scaleFixed ? 1 : scale)}
              disabled={scaleFixed}
              onValueChange={(next) => { onScale(Number(next) as ExportScale); }}
            >
              {SCALES.map((s) => {
                const label = resolutionLabel(exportPlan(scene, format, s).width);
                return (
                  <SegmentedControlItem key={s} value={String(s)}>
                    {`${String(s)}x`}
                    {label !== undefined && !scaleFixed && (
                      <span className="text-caption ml-1 tabular-nums">{label}</span>
                    )}
                  </SegmentedControlItem>
                );
              })}
            </SegmentedControl>
            {scaleFixed && (
              <p className="text-caption tabular-nums">
                {t('editor.export.scaleFixed', { width: plan.width, height: plan.height })}
              </p>
            )}
            <DetailsCard>
              <DetailsRow label={t('editor.details.image')} value={size(imageSize)} />
              <DetailsRow
                label={t('editor.details.saveAs')}
                value={`${format.toUpperCase()} · ${size(plan)}`}
              />
            </DetailsCard>
            <Button
              variant="ghost"
              size="sm"
              className="w-full cursor-grab touch-none select-none"
              title={t('editor.export.dragHint')}
              draggable={false}
              disabled={busy}
              {...dragHandlers}
            >
              <GripIcon />
              {t('editor.export.drag')}
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              title={`${t('editor.export.saveAs')} (Ctrl+Shift+S)`}
              disabled={busy}
              onClick={onSaveAs}
            >
              {t('editor.export.saveAs')}
            </Button>
          </div>
        </Section></div>
      </div>
    </aside>
  );
}
