import { ANNOTATION_DEFAULTS, ANNOTATION_FONT, annotationBounds, type Scene } from '@cropa/core';
import { useEffect, useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { handlesFor, stepNumber } from './annotation-edits.ts';
import { imagePerCss, toCss, type PreviewGeometry } from './geometry.ts';
import { measureText } from './measure.ts';
import type { Annotate } from './use-annotate.ts';

interface Props {
  annotate: Annotate;
  scene: Scene;
  geometry: PreviewGeometry;
}

const HANDLE_SIZE = 8;

/** The layer over the preview canvas: it takes the pointer and draws the selection. */
export function AnnotationOverlay({ annotate, scene, geometry: g }: Props) {
  const { t } = useTranslation();
  const { selected, editing } = annotate;
  const field = useRef<HTMLTextAreaElement>(null);
  const { setGeometry } = annotate;
  useEffect(() => { setGeometry(g); }, [setGeometry, g]);
  useEffect(() => {
    const el = field.current;
    if (!editing || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // Only when the editor opens, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing === null, editing?.index, editing?.at.x, editing?.at.y]);

  const chosen = selected === null ? undefined : scene.annotations[selected];
  let selection: React.ReactNode = null;
  if (selected !== null && chosen && !editing) {
    const b = annotationBounds(chosen, measureText);
    const topLeft = toCss(scene, g, { x: b.x, y: b.y });
    const bottomRight = toCss(scene, g, { x: b.x + b.w, y: b.y + b.h });
    const n = stepNumber(scene, selected);
    const label = n === null ? t(`editor.annotate.tools.${chosen.type}`) : t('editor.annotate.step', { n });
    selection = (
      <svg
        className="pointer-events-none absolute inset-0 overflow-visible"
        width={g.css.width}
        height={g.css.height}
      >
        <rect
          role="img"
          aria-label={label}
          x={topLeft.x}
          y={topLeft.y}
          width={bottomRight.x - topLeft.x}
          height={bottomRight.y - topLeft.y}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={1.5}
        />
        {handlesFor(chosen).map((h) => {
          const c = toCss(scene, g, h);
          return (
            <rect
              key={h.handle}
              x={c.x - HANDLE_SIZE / 2}
              y={c.y - HANDLE_SIZE / 2}
              width={HANDLE_SIZE}
              height={HANDLE_SIZE}
              fill="#ffffff"
              stroke="var(--primary)"
              strokeWidth={1.5}
            />
          );
        })}
      </svg>
    );
  }

  let textField: React.ReactNode = null;
  if (editing) {
    const existing = editing.index === null ? undefined : scene.annotations[editing.index];
    const fontSize = existing?.style?.fontSize ?? (existing ? ANNOTATION_DEFAULTS.fontSize : annotate.style.fontSize);
    const color = existing?.style?.color ?? (existing ? ANNOTATION_DEFAULTS.color : annotate.style.color);
    const at = toCss(scene, g, editing.at);
    const style: CSSProperties = {
      left: at.x,
      top: at.y,
      font: `600 ${fontSize / imagePerCss(scene, g)}px ${ANNOTATION_FONT}`,
      lineHeight: 1.25,
      padding: '0.25em 0.5em',
      color,
      fieldSizing: 'content',
      minWidth: '2em',
    };
    textField = (
      <textarea
        ref={field}
        rows={1}
        value={editing.text}
        placeholder={t('editor.annotate.textPlaceholder')}
        aria-label={t('editor.annotate.tools.text')}
        maxLength={2000}
        className="absolute resize-none overflow-hidden bg-transparent outline-1 outline-offset-0 outline-dashed outline-primary placeholder:opacity-40"
        style={style}
        onChange={(event) => { annotate.setEditingText(event.target.value); }}
        onBlur={annotate.commitText}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            annotate.cancelText();
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            annotate.commitText();
          }
        }}
      />
    );
  }

  return (
    <div
      className="absolute inset-0 touch-none"
      style={{ cursor: annotate.cursor }}
      onPointerDown={(event) => { annotate.onPointerDown(event, g); }}
      onPointerMove={(event) => { annotate.onPointerMove(event, g); }}
      onPointerUp={annotate.onPointerUp}
      onPointerCancel={annotate.onPointerUp}
      onDoubleClick={(event) => { annotate.onDoubleClick(event, g); }}
    >
      {selection}
      {textField}
    </div>
  );
}
