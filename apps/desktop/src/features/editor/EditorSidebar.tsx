import { PLATFORM_IDS, PLATFORM_SIZES, outputSize, type PlatformId } from '@cropa/core';
import {
  ColorInput,
  Button,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
} from '@cropa/ui';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeOutputTooLarge } from '../../lib/errors.ts';
import {
  ASPECT_PRESETS,
  BACKGROUND_KINDS,
  SHADOW_LEVELS,
  aspectPreset,
  backgroundAngle,
  backgroundBlur,
  backgroundColors,
  backgroundKind,
  frameRanges,
  matchImageColor,
  platformMatches,
  presetRatio,
  setAspectRatio,
  setBackgroundAngle,
  setBackgroundBlur,
  setBackgroundColor,
  setBackgroundKind,
  setBorderColor,
  setBorderWidth,
  setInset,
  setInsetColor,
  setPadding,
  setPlatformSize,
  setRadius,
  setShadowLevel,
  shadowLevel,
  type AspectPreset,
  type BackgroundKind,
  type ShadowLevel,
} from './scene-edits.ts';
import type { SceneHistory } from './use-scene-history.ts';

interface Props {
  history: Pick<SceneHistory, 'scene' | 'blocked' | 'edit' | 'preview' | 'commit'>;
  /** The colour found at the screenshot's edges, or null when it has none. */
  edgeColor: string | null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b p-4 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        {value !== undefined && <span className="text-muted-foreground tabular-nums">{value}</span>}
      </div>
      {children}
    </div>
  );
}

interface SliderRowProps {
  label: string;
  value: string;
  current: number;
  range: readonly [number, number];
  onPreview: (value: number) => void;
  onCommit: () => void;
}

function SliderRow({ label, value, current, range, onPreview, onCommit }: SliderRowProps) {
  return (
    <Row label={label} value={value}>
      <Slider
        aria-label={label}
        min={Math.min(range[0], current)}
        max={Math.max(range[1], current)}
        step={1}
        value={[current]}
        onValueChange={([next]) => {
          if (next !== undefined) onPreview(next);
        }}
        // Radix commits a keyboard change before it reports the value, so wait for the
        // preview to be dispatched; otherwise the drag would stay open.
        onValueCommit={() => { queueMicrotask(onCommit); }}
      />
    </Row>
  );
}

/** A positive number field for one side of a custom aspect ratio; an invalid entry reverts. */
function RatioField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(String(value));
  }
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() !== '' && parsed >= 0.01 && parsed <= 100) onCommit(parsed);
    // An accepted value comes back through `value`; a rejected one is dropped.
    setDraft(String(value));
  };
  return (
    <Input
      type="number"
      min={0.01}
      max={100}
      step="any"
      aria-label={label}
      value={draft}
      onChange={(event) => { setDraft(event.target.value); }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}

export function EditorSidebar({ history, edgeColor }: Props) {
  const { t } = useTranslation();
  const { scene, blocked, edit, preview, commit } = history;
  const { background, frame } = scene;
  const kind = backgroundKind(background);
  const colors = backgroundColors(background);
  const angle = backgroundAngle(background);
  const ranges = frameRanges(scene.screenshot);
  const level = shadowLevel(scene);
  const preset = aspectPreset(scene);
  const ratio = scene.output.aspectRatio;
  // The last colour the border had, for when a drag brings it back from width 0.
  const [borderColor, setBorderColorMemo] = useState('#ffffff');
  // Facebook and Threads share a size, so the scene alone can't say which was clicked.
  const [lastPlatform, setLastPlatform] = useState<PlatformId>();
  const platform =
    lastPlatform && platformMatches(scene, lastPlatform)
      ? lastPlatform
      : PLATFORM_IDS.find((id) => platformMatches(scene, id));
  if (frame.border && frame.border.color !== borderColor) setBorderColorMemo(frame.border.color);

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
      {blocked && (
        <div className="border-b p-4">
          <ErrorNotice error={describeOutputTooLarge(t)} />
        </div>
      )}
      <Section title={t('editor.background.title')}>
        <Row label={t('editor.background.type')}>
          <Select
            value={kind}
            onValueChange={(next) => { edit((s) => setBackgroundKind(s, next as BackgroundKind)); }}
          >
            <SelectTrigger aria-label={t('editor.background.type')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BACKGROUND_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`editor.background.kind.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        {colors.map((color, index) => (
          <Row key={index} label={t('editor.background.color', { n: index + 1 })}>
            <ColorInput
              value={color}
              swatchLabel={t('editor.background.colorPicker', { n: index + 1 })}
              textLabel={t('editor.background.colorHex', { n: index + 1 })}
              onValueChange={(hex) => { preview((s) => setBackgroundColor(s, index, hex)); }}
              onValueCommit={(hex) => { edit((s) => setBackgroundColor(s, index, hex)); }}
            />
          </Row>
        ))}
        {angle !== null && (
          <SliderRow
            label={t('editor.background.angle')}
            value={t('editor.units.deg', { value: angle })}
            current={angle}
            range={[0, 360]}
            onPreview={(next) => { preview((s) => setBackgroundAngle(s, next)); }}
            onCommit={commit}
          />
        )}
        {kind !== 'none' && (
          <SliderRow
            label={t('editor.background.blur')}
            value={String(backgroundBlur(background))}
            current={backgroundBlur(background)}
            range={[0, 100]}
            onPreview={(next) => { preview((s) => setBackgroundBlur(s, next)); }}
            onCommit={commit}
          />
        )}
        <Button
          variant="outline"
          disabled={edgeColor === null}
          onClick={() => {
            if (edgeColor !== null) edit((s) => matchImageColor(s, edgeColor));
          }}
        >
          {t('editor.background.matchImage')}
        </Button>
      </Section>

      <Section title={t('editor.frame.title')}>
        <SliderRow
          label={t('editor.frame.padding')}
          value={px(frame.padding)}
          current={frame.padding}
          range={ranges.padding}
          onPreview={(next) => { preview((s) => setPadding(s, next)); }}
          onCommit={commit}
        />
        <SliderRow
          label={t('editor.frame.radius')}
          value={px(frame.radius)}
          current={frame.radius}
          range={ranges.radius}
          onPreview={(next) => { preview((s) => setRadius(s, next)); }}
          onCommit={commit}
        />
        <Row label={t('editor.frame.shadow')}>
          <SegmentedControl
            aria-label={t('editor.frame.shadow')}
            value={level ?? undefined}
            onValueChange={(next) => { edit((s) => setShadowLevel(s, next as ShadowLevel)); }}
          >
            {SHADOW_LEVELS.map((l) => (
              <SegmentedControlItem key={l} value={l}>
                {t(`editor.frame.shadowLevel.${l}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Row>
        <SliderRow
          label={t('editor.frame.border')}
          value={px(frame.border?.width ?? 0)}
          current={frame.border?.width ?? 0}
          range={ranges.border}
          onPreview={(next) => { preview((s) => setBorderWidth(s, next, borderColor)); }}
          onCommit={commit}
        />
        <Row label={t('editor.frame.borderColor')}>
          <ColorInput
            value={frame.border?.color ?? '#ffffff'}
            swatchLabel={t('editor.frame.borderColorPicker')}
            textLabel={t('editor.frame.borderColorHex')}
            onValueChange={(hex) => { preview((s) => setBorderColor(s, hex)); }}
            onValueCommit={(hex) => { edit((s) => setBorderColor(s, hex)); }}
          />
        </Row>
        <SliderRow
          label={t('editor.frame.inset')}
          value={px(frame.inset)}
          current={frame.inset}
          range={ranges.inset}
          onPreview={(next) => { preview((s) => setInset(s, next)); }}
          onCommit={commit}
        />
        <Row label={t('editor.frame.insetColor')}>
          <SegmentedControl
            aria-label={t('editor.frame.insetColor')}
            value={frame.insetColor === 'auto' ? 'auto' : 'custom'}
            onValueChange={(next) => {
              edit((s) => setInsetColor(s, next === 'auto' ? 'auto' : (edgeColor ?? '#ffffff')));
            }}
          >
            <SegmentedControlItem value="auto">{t('editor.frame.insetAuto')}</SegmentedControlItem>
            <SegmentedControlItem value="custom">
              {t('editor.frame.insetCustom')}
            </SegmentedControlItem>
          </SegmentedControl>
          {frame.insetColor !== 'auto' && (
            <ColorInput
              value={frame.insetColor}
              swatchLabel={t('editor.frame.insetColorPicker')}
              textLabel={t('editor.frame.insetColorHex')}
              onValueChange={(hex) => { preview((s) => setInsetColor(s, hex)); }}
              onValueCommit={(hex) => { edit((s) => setInsetColor(s, hex)); }}
            />
          )}
        </Row>
      </Section>

      <Section title={t('editor.aspect.title')}>
        <SegmentedControl
          aria-label={t('editor.aspect.title')}
          value={platform ? undefined : preset}
          onValueChange={chooseAspect}
          className="grid-flow-row grid-cols-3"
        >
          {ASPECT_PRESETS.map((p) => (
            <SegmentedControlItem key={p} value={p}>
              {p === 'auto' || p === 'custom' ? t(`editor.aspect.${p}`) : p}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
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
        <Row label={t('editor.aspect.platform.title')}>
          <SegmentedControl
            aria-label={t('editor.aspect.platform.title')}
            value={platform}
            onValueChange={choosePlatform}
            className="grid-flow-row grid-cols-2"
          >
            {PLATFORM_IDS.map((id) => (
              <SegmentedControlItem key={id} value={id}>
                {t(`editor.aspect.platform.${id}`)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {platform && (
            <p className="text-sm text-muted-foreground tabular-nums">
              {t('editor.aspect.platform.size', {
                width: PLATFORM_SIZES[platform].width,
                height: PLATFORM_SIZES[platform].height,
              })}
            </p>
          )}
        </Row>
      </Section>
    </>
  );
}
