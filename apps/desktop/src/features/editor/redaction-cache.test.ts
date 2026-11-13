import { defaultScene, type Annotation, type Scene } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import { redactionKey } from './redaction-cache.ts';

const mark = (type: Annotation['type'], box: Annotation['box']): Annotation => ({
  version: 1,
  type,
  box,
});

describe('redactionKey', () => {
  const blur = mark('blur', [10, 10, 50, 50]);
  const base = (): Scene => ({
    ...defaultScene({ width: 400, height: 300 }),
    annotations: [blur, mark('arrow', [0, 0, 20, 20])],
  });

  it('is empty without redactions', () => {
    const arrowOnly: Scene = { ...base(), annotations: [mark('arrow', [0, 0, 5, 5])] };
    expect(redactionKey(arrowOnly)).toBe('');
  });

  it('ignores the frame and vector annotations', () => {
    const scene = base();
    const changed: Scene = {
      ...scene,
      frame: { ...scene.frame, padding: scene.frame.padding + 10 },
      annotations: [blur, mark('arrow', [5, 5, 99, 99])],
    };
    expect(redactionKey(changed)).toBe(redactionKey(scene));
  });

  it('changes when a redaction moves', () => {
    const scene = base();
    const moved: Scene = { ...scene, annotations: [mark('blur', [11, 10, 50, 50])] };
    expect(redactionKey(moved)).not.toBe(redactionKey(scene));
  });
});
