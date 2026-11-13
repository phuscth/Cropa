import {
  PLATFORM_IDS,
  PLATFORM_SIZES,
  outputSize,
  type PaletteColour,
  type PlatformId,
} from '@cropa/core';
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
  SliderField,
  Tile,
  TileGroup,
} from '@cropa/ui';
import { useId, useState, type CSSProperties } from 'react';
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
import { AiBackground } from './AiBackground.tsx';
import { BackgroundImages } from './BackgroundImages.tsx';
import { beginBackgroundChange } from './background-images.ts';
import { PresetsSection } from './presets/PresetsSection.tsx';
import { Row, Section } from './Section.tsx';
import type { SceneHistory } from './use-scene-history.ts';

type Tab = 'background' | 'frame';

interface Props {
  history: Pick<SceneHistory, 'scene' | 'blocked' | 'edit' | 'preview' | 'commit'>;
  /** The screenshot's size in pixels. */
  imageSize: { width: number; height: number };
  /** The colour found at the screenshot's edges, or null when it has none. */
  edgeColor: string | null;
  /** The screenshot's dominant colours, heaviest first; empty when they could not be read. */
  palette: readonly PaletteColour[];
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
    <SliderField
      label={label}
      valueText={value}
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
  );
}

/** The shadow each level casts in its tile, drawn in CSS: an illustration, not the renderer. */
const SHADOW_SWATCH: Record<ShadowLevel, CSSProperties['boxShadow']> = {
  none: 'none',
  soft: '0 2px 5px rgb(0 0 0 / 0.2)',
  medium: '0 4px 10px rgb(0 0 0 / 0.32)',
  strong: '0 6px 14px rgb(0 0 0 / 0.5)',
};

function ShadowThumb({ level }: { level: ShadowLevel }) {
  return (
    <span
      aria-hidden="true"
      className="size-7 rounded-md bg-white"
      style={{ boxShadow: SHADOW_SWATCH[level] }}
    />
  );
}

/** A rectangle outline in the given ratio, at most 28px on its long side. */
function RatioThumb({ ratio }: { ratio: readonly [number, number] }) {
  const scale = 28 / Math.max(ratio[0], ratio[1]);
  return (
    <span
      aria-hidden="true"
      className="rounded-[3px] border-2 border-foreground/60"
      style={{ width: ratio[0] * scale, height: ratio[1] * scale }}
    />
  );
}

/** Auto adapts to the image, so its outline is dashed. */
function AutoThumb() {
  return (
    <span
      aria-hidden="true"
      className="h-5 w-7 rounded-[3px] border-2 border-dashed border-foreground/60"
    />
  );
}

/** Custom is an outline with a plus. */
function CustomThumb() {
  return (
    <span
      aria-hidden="true"
      className="relative flex h-5 w-7 items-center justify-center rounded-[3px] border-2 border-foreground/60"
    >
      <svg viewBox="0 0 8 8" className="size-2" fill="currentColor">
        <path d="M3.25 0h1.5v3.25H8v1.5H4.75V8h-1.5V4.75H0v-1.5h3.25z" />
      </svg>
    </span>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
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

/** The editor's panel: the Background and Frame tabs, then the details of the image. */
export function EditorSidebar({ history, imageSize, edgeColor, palette }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('background');
  const tabsId = useId();
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

  const output = outputSize(scene, 1);
  const tabId = (name: Tab) => `${tabsId}-${name}-tab`;
  const panelId = (name: Tab) => `${tabsId}-${name}-panel`;

  return (
    <aside
      aria-label={t('editor.panel.label')}
      className="m-2 ml-0 flex w-[272px] shrink-0 flex-col gap-5 overflow-y-auto rounded-2xl bg-panel p-3"
    >
      {blocked && <ErrorNotice error={describeOutputTooLarge(t)} />}

      <SegmentedControl
        aria-label={t('editor.panel.tabs')}
        value={tab}
        onValueChange={(next) => { setTab(next as Tab); }}
      >
        {(['background', 'frame'] as const).map((name) => (
          <SegmentedControlItem
            key={name}
            id={tabId(name)}
            value={name}
            aria-controls={panelId(name)}
          >
            {t(`editor.panel.${name}`)}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>

      {/* Both tabs stay mounted, so a half-written AI description and the preset list survive a switch. */}
      <div
        id={panelId('background')}
        role="group"
        aria-labelledby={tabId('background')}
        hidden={tab !== 'background'}
        className="flex flex-col gap-5"
      >
        <PresetsSection
          history={history}
          onExport={() => { setTab('background'); }}
        />
        <Section title={t('editor.background.title')}>
          <div className="flex flex-col gap-3">
            <Row label={t('editor.background.type')}>
              <Select
                value={kind}
                onValueChange={(next) => {
                  beginBackgroundChange();
                  edit((s) => setBackgroundKind(s, next as BackgroundKind));
                }}
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
            {kind === 'image' && <BackgroundImages history={history} />}
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
              variant="secondary"
              className="w-full"
              disabled={edgeColor === null}
              onClick={() => {
                if (edgeColor !== null) edit((s) => matchImageColor(s, edgeColor));
              }}
            >
              {t('editor.background.matchImage')}
            </Button>
          </div>
        </Section>
        <AiBackground history={history} palette={palette} />
      </div>

      <div
        id={panelId('frame')}
        role="group"
        aria-labelledby={tabId('frame')}
        hidden={tab !== 'frame'}
        className="flex flex-col gap-5"
      >
        <Section title={t('editor.frame.title')}>
          <div className="flex flex-col gap-3">
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
          </div>
        </Section>

        <Section title={t('editor.frame.shadow')}>
          <TileGroup
            aria-label={t('editor.frame.shadow')}
            value={level ?? undefined}
            onValueChange={(next) => { edit((s) => setShadowLevel(s, next as ShadowLevel)); }}
            className="grid-cols-4"
          >
            {SHADOW_LEVELS.map((l) => (
              <Tile key={l} value={l} label={t(`editor.frame.shadowLevel.${l}`)}>
                <ShadowThumb level={l} />
              </Tile>
            ))}
          </TileGroup>
        </Section>

        <Section title={t('editor.aspect.title')}>
          <TileGroup
            aria-label={t('editor.aspect.title')}
            value={platform ? undefined : preset}
            onValueChange={chooseAspect}
          >
            {ASPECT_PRESETS.map((p) => (
              <Tile
                key={p}
                value={p}
                label={p === 'auto' || p === 'custom' ? t(`editor.aspect.${p}`) : p}
                thumbClassName="aspect-[4/3]"
              >
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
            className="grid-cols-2"
          >
            {PLATFORM_IDS.map((id) => (
              <Tile
                key={id}
                value={id}
                label={t(`editor.aspect.platform.${id}`)}
                thumbClassName="aspect-[2/1]"
              >
                <RatioThumb ratio={PLATFORM_SIZES[id].aspect} />
              </Tile>
            ))}
          </TileGroup>
          {platform && (
            <p className="text-sm text-muted-foreground tabular-nums">
              {t('editor.aspect.platform.size', {
                width: PLATFORM_SIZES[platform].width,
                height: PLATFORM_SIZES[platform].height,
              })}
            </p>
          )}
        </Section>
      </div>

      <Section title={t('editor.details.title')}>
        <dl className="flex flex-col gap-1.5 rounded-xl border p-3 text-xs">
          <Detail label={t('editor.details.image')} value={t('editor.details.size', imageSize)} />
          <Detail label={t('editor.details.output')} value={t('editor.details.size', output)} />
          <Detail label={t('editor.details.format')} value="PNG" />
        </dl>
      </Section>
    </aside>
  );
}
