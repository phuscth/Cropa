import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** Longer than the exit animation, for when `animationend` never fires (the view is hidden). */
const EXIT_FALLBACK_MS = 320;

/** The flex gap of the editor's `<main>` that separates a panel from the canvas, in px. */
const GAP = 6;

type Phase = 'gone' | 'resting' | 'entering' | 'closing';

interface Props {
  open: boolean;
  /** The window edge the panel sits against and slides to and from. */
  side: 'left' | 'right';
  /** The panel's own width in px, without the gap. */
  width: number;
  /** Keeps the panel mounted, hidden, while it is closed, so its own state survives. */
  keepMounted?: boolean;
  children: ReactNode;
}

/**
 * Holds a panel beside the canvas, on its left or right. Opening grows the space the panel takes
 * while it slides in from the window's edge and fades in; closing plays that backwards and only then
 * unmounts the panel (or hides it, with `keepMounted`). Under reduced motion the space changes at
 * once and the panel only fades.
 */
export function PanelDock({ open, side, width, keepMounted = false, children }: Props) {
  // Already open when the editor mounts: shown as it is, without the entrance.
  const [phase, setPhase] = useState<Phase>(open ? 'resting' : 'gone');
  const space = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Before the paint that shows the new phase, while the old animation is still applied: hands the
  // keyframes the dock's current width, opacity and offset, so a reversal starts where it is.
  useLayoutEffect(() => {
    const next = open ? 'entering' : 'closing';
    if (open ? phase !== 'gone' && phase !== 'closing' : phase !== 'resting' && phase !== 'entering') return;
    if (space.current && panel.current) {
      if (phase === 'gone') {
        // Opening from hidden: a hidden element reads as fully opaque and zero wide, so the
        // keyframes' own starting values apply instead.
        space.current.style.removeProperty('--dock-from');
        panel.current.style.removeProperty('--panel-opacity');
        panel.current.style.removeProperty('--panel-x');
      } else {
        const style = getComputedStyle(panel.current);
        space.current.style.setProperty('--dock-from', `${String(space.current.getBoundingClientRect().width)}px`);
        panel.current.style.setProperty('--panel-opacity', style.opacity);
        panel.current.style.setProperty('--panel-x', `${String(new DOMMatrixReadOnly(style.transform).m41)}px`);
      }
    }
    // The phase has to flip in this same pass, before paint, with the values just read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase(next);
    // Only a change of `open` flips the phase; the phase it leaves is read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (phase !== 'closing') return undefined;
    const timer = setTimeout(() => { setPhase('gone'); }, EXIT_FALLBACK_MS);
    return () => { clearTimeout(timer); };
  }, [phase]);

  const gone = phase === 'gone';
  if (gone && !keepMounted) return null;
  const right = side === 'right';
  const vars = {
    '--dock-width': `${String(width + GAP)}px`,
    '--dock-side': right ? 1 : -1,
  } as CSSProperties;
  return (
    // The negative margin cancels the flex gap at zero width; the padding puts it back inside.
    <div
      ref={space}
      hidden={gone}
      style={vars}
      className={
        (right ? '-ml-1.5 justify-end ' : '-mr-1.5 justify-start ') +
        'flex shrink-0 overflow-hidden ' +
        (phase === 'entering'
          ? 'motion-safe:animate-dock-space-in'
          : phase === 'closing'
            ? 'motion-safe:animate-dock-space-out'
            : '')
      }
    >
      <div
        ref={panel}
        className={
          (right ? 'pl-1.5 ' : 'pr-1.5 ') +
          'flex ' +
          (phase === 'entering' ? 'animate-dock-in' : phase === 'closing' ? 'animate-dock-out' : '')
        }
        // Back to resting once in, so showing the editor view again does not replay the entrance.
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.animationName === 'dock-out') setPhase('gone');
          else if (event.animationName === 'dock-in') {
            event.currentTarget.style.removeProperty('--panel-opacity');
            event.currentTarget.style.removeProperty('--panel-x');
            space.current?.style.removeProperty('--dock-from');
            setPhase('resting');
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
