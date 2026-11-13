import type { PaletteColour } from '@cropa/core';
import {
  Button,
  ColorInput,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tile,
  TileGroup,
} from '@cropa/ui';
import { useId, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeOutputTooLarge } from '../../lib/errors.ts';
import {
  BACKGROUND_KINDS,
  SHADOW_LEVELS,
  backgroundAngle,
  backgroundBlur,
  backgroundColors,
  backgroundKind,
  frameRanges,
  matchImageColor,
  setBackgroundAngle,
  setBackgroundBlur,
  setBackgroundColor,
  setBackgroundKind,
  setBorderColor,
  setBorderWidth,
  setInsetColor,
  setRadius,
  setShadowLevel,
  shadowLevel,
  type BackgroundKind,
  type ShadowLevel,
} from './scene-edits.ts';
import { AiBackground } from './AiBackground.tsx';
import { BackgroundImages } from './BackgroundImages.tsx';
import { beginBackgroundChange } from './background-images.ts';
import { ShadowThumb, SliderRow } from './panel-parts.tsx';
import { readCustomizeOpen, writeCustomizeOpen } from './panel-state.ts';
import { PresetPicker } from './presets/PresetPicker.tsx';
import { CollapsibleSection, Row, Section } from './Section.tsx';
import type { SceneHistory } from './use-scene-history.ts';

type Tab = 'background' | 'frame';
const TABS: readonly Tab[] = ['background', 'frame'];

interface Props {
  history: Pick<SceneHistory, 'scene' | 'blocked' | 'edit' | 'preview' | 'commit'>;
  /** The colour found at the screenshot's edges, or null when it has none. */
  edgeColor: string | null;
  /** The screenshot's dominant colours, heaviest first; empty when they could not be read. */
  palette: readonly PaletteColour[];
}

/** The editor's left panel: the Background and Frame tabs. */
export function EditorSidebar({ history, edgeColor, palette }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('background');
  // Which way the content slides in: from the right when the tab is further along.
  const [direction, setDirection] = useState<1 | -1>(1);
  const [customizeOpen, setCustomizeOpen] = useState(readCustomizeOpen);
  const tabsId = useId();
  const { scene, blocked, edit, preview, commit } = history;
  const { background, frame } = scene;
  const kind = backgroundKind(background);
  const colors = backgroundColors(background);
  const angle = backgroundAngle(background);
  const ranges = frameRanges(scene.screenshot);
  const level = shadowLevel(scene);
  // The last colour the border had, for when a drag brings it back from width 0.
  const [borderColor, setBorderColorMemo] = useState('#ffffff');
  if (frame.border && frame.border.color !== borderColor) setBorderColorMemo(frame.border.color);

  const px = (value: number) => t('editor.units.px', { value });
  const tabId = (name: Tab) => `${tabsId}-${name}-tab`;
  const panelId = (name: Tab) => `${tabsId}-${name}-panel`;
  const slideFrom = { '--tab-from': `calc(var(--motion-slide) * ${String(direction)})` } as CSSProperties;

  return (
    <aside
      aria-label={t('editor.panel.label')}
      className="flex w-[248px] shrink-0 flex-col overflow-hidden rounded-2xl bg-panel"
    >
      <div className="shrink-0 p-2">
        <SegmentedControl
          size="tab"
          aria-label={t('editor.panel.tabs')}
          value={tab}
          onValueChange={(next) => {
            const value = next as Tab;
            setDirection(TABS.indexOf(value) > TABS.indexOf(tab) ? 1 : -1);
            setTab(value);
          }}
        >
          {TABS.map((name) => (
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
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3 pt-2">
        {blocked && <ErrorNotice error={describeOutputTooLarge(t)} />}

        {/* Both tabs stay mounted, so a half-written AI description and the preset list survive a switch. */}
        <div
          id={panelId('background')}
          role="group"
          aria-labelledby={tabId('background')}
          hidden={tab !== 'background'}
          style={slideFrom}
          className="flex animate-tab-in flex-col gap-5"
        >
          <PresetPicker history={history} onExport={() => { setTab('background'); }} />
          <AiBackground history={history} palette={palette} />
          <CollapsibleSection
            title={t('editor.background.customize')}
            open={customizeOpen}
            onOpenChange={(next) => {
              setCustomizeOpen(next);
              writeCustomizeOpen(next);
            }}
          >
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
              size="sm"
              className="w-full"
              disabled={edgeColor === null}
              onClick={() => {
                if (edgeColor !== null) edit((s) => matchImageColor(s, edgeColor));
              }}
            >
              {t('editor.background.matchImage')}
            </Button>
            {kind === 'image' && (
              <Section title={t('editor.background.images.title')}>
                <BackgroundImages history={history} />
              </Section>
            )}
          </CollapsibleSection>
        </div>

        <div
          id={panelId('frame')}
          role="group"
          aria-labelledby={tabId('frame')}
          hidden={tab !== 'frame'}
          style={slideFrom}
          className="flex animate-tab-in flex-col gap-5"
        >
          <Section title={t('editor.frame.corners')}>
            <SliderRow
              label={t('editor.frame.radius')}
              value={px(frame.radius)}
              current={frame.radius}
              range={ranges.radius}
              onPreview={(next) => { preview((s) => setRadius(s, next)); }}
              onCommit={commit}
            />
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

          <Section title={t('editor.frame.border')}>
            <div className="flex flex-col gap-2.5">
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
            </div>
          </Section>

          <Section title={t('editor.frame.insetColor')}>
            <div className="flex flex-col gap-2.5">
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
            </div>
          </Section>
        </div>
      </div>
    </aside>
  );
}
