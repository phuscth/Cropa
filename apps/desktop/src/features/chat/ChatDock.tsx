import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Longer than the exit animation, for when `animationend` never fires (the view is hidden). */
const EXIT_FALLBACK_MS = 320;

type Phase = 'gone' | 'resting' | 'entering' | 'closing';

/**
 * Holds the chat panel beside the canvas. Opening grows the space the panel takes while it slides
 * in from the window's edge and fades in; closing plays that backwards and only then unmounts the
 * panel. Under reduced motion the space changes at once and the panel only fades.
 */
export function ChatDock({ open, children }: { open: boolean; children: ReactNode }) {
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
      const style = getComputedStyle(panel.current);
      space.current.style.setProperty('--dock-from', `${String(space.current.getBoundingClientRect().width)}px`);
      panel.current.style.setProperty('--panel-opacity', style.opacity);
      panel.current.style.setProperty('--panel-x', `${String(new DOMMatrixReadOnly(style.transform).m41)}px`);
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

  if (phase === 'gone') return null;
  return (
    // The negative margin cancels the flex gap at zero width; the padding puts it back inside.
    <div
      ref={space}
      className={
        '-ml-1.5 flex shrink-0 justify-end overflow-hidden ' +
        (phase === 'entering'
          ? 'motion-safe:animate-chat-space-in'
          : phase === 'closing'
            ? 'motion-safe:animate-chat-space-out'
            : '')
      }
    >
      <div
        ref={panel}
        className={
          'flex pl-1.5 ' +
          (phase === 'entering' ? 'animate-chat-in' : phase === 'closing' ? 'animate-chat-out' : '')
        }
        // Back to resting once in, so showing the editor view again does not replay the entrance.
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.animationName === 'chat-out') setPhase('gone');
          else if (event.animationName === 'chat-in') {
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
