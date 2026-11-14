import { defaultScene, type Annotation, type RenderEnv, type Scene } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import { pictureToSend } from './send-image.ts';

const W = 40;
const H = 30;

/** A canvas that keeps its pixels in memory: a checker, so a blurred box visibly changes. */
function fakeEnv() {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    const v = (i + Math.floor(i / W)) % 2 === 0 ? 0 : 255;
    pixels.set([v, v, v, 255], i * 4);
  }
  const canvas = { width: W, height: H };
  const ctx = {
    canvas,
    drawImage: () => undefined,
    getImageData: (x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let r = 0; r < h; r += 1) {
        for (let c = 0; c < w; c += 1) {
          const from = ((y + r) * W + x + c) * 4;
          data.set(pixels.subarray(from, from + 4), (r * w + c) * 4);
        }
      }
      return { data, width: w, height: h };
    },
    putImageData: (image: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number) => {
      for (let r = 0; r < image.height; r += 1) {
        for (let c = 0; c < image.width; c += 1) {
          const from = (r * image.width + c) * 4;
          pixels.set(image.data.subarray(from, from + 4), ((y + r) * W + x + c) * 4);
        }
      }
    },
  };
  const env = { screenshot: { width: W, height: H }, createContext: () => ctx } as unknown as RenderEnv;
  return { env, canvas, pixels };
}

const mark = (type: Annotation['type'], box: Annotation['box']): Annotation => ({ version: 1, type, box });
const sceneWith = (annotations: Annotation[]): Scene => ({ ...defaultScene({ width: W, height: H }), annotations });

describe('pictureToSend', () => {
  it('sends the stored picture when nothing is redacted', async () => {
    const { env } = fakeEnv();
    const encode = () => Promise.reject(new Error('nothing to encode'));
    const sent = await pictureToSend(sceneWith([mark('arrow', [0, 0, 10, 10])]), env, 'data:original', encode);
    expect(sent).toBe('data:original');
  });

  it('sends the picture with the redacted areas applied, and only those', async () => {
    const { env, pixels } = fakeEnv();
    const before = pixels.slice();
    const sent = await pictureToSend(
      sceneWith([mark('pixelate', [0, 0, 20, 20])]),
      env,
      'data:original',
      (canvas) => {
        expect(canvas).toBeDefined();
        return Promise.resolve('data:redacted');
      },
    );
    expect(sent).toBe('data:redacted');
    // Inside the box the checker is gone; outside it, every pixel is as it was.
    expect(pixels[0]).not.toBe(before[0]);
    const outside = (W * 25 + 30) * 4;
    expect(Array.from(pixels.subarray(outside, outside + 4))).toEqual(Array.from(before.subarray(outside, outside + 4)));
  });
});
