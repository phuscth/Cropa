import { PLATFORM_IDS, PLATFORM_SIZES, outputSize, type PlatformId } from '@cropa/core';
import { Tile, TileGroup } from '@cropa/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

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

interface Props {
  history: Pick<SceneHistory, 'scene' | 'edit' | 'preview' | 'commit'>;
}

/** The layout of the output: aspect ratio, platform size and spacing. */
export function LayoutSections({ history }: Props) {
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

  return (
    <>
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
    </>
  );
}
