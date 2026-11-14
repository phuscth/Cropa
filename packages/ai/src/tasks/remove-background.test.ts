import { describe, expect, it } from 'vitest';

import { MockTransport } from '../mock-transport.ts';
import { runTask } from '../run-task.ts';

import { removeBackgroundTask } from './remove-background.ts';

const SHOT = 'data:image/png;base64,c2NyZWVuc2hvdA==';
const CUTOUT = 'data:image/png;base64,Y3V0b3V0';

const codex = { name: 'codex', capabilities: ['image-in', 'image-out'] } as const;

const confirmImages = () => Promise.resolve(true);

describe('removeBackgroundTask', () => {
  it('sends the one picture and asks for an image', () => {
    const prompt = removeBackgroundTask.buildPrompt({ image: SHOT });
    expect(prompt.images).toEqual([SHOT]);
    expect(prompt.system).toBe('');
    expect(prompt.user).toContain('transparent');
    expect(prompt.user).toContain('image generation tool once');
    expect(prompt.user).toContain('reply with one word: done');
    expect(removeBackgroundTask.requires).toEqual(['image-in', 'image-out']);
    expect(removeBackgroundTask.id).toBe('remove-background');
    expect(removeBackgroundTask.timeoutMs).toBe(180_000);
  });

  it('answers with the provider image after one call', async () => {
    const transport = new MockTransport([{ json: 'done', image: CUTOUT }]);
    const out = await runTask(
      removeBackgroundTask,
      { image: SHOT },
      { transport, provider: codex, confirmImages, effort: 'low' },
    ).done;
    expect(out).toEqual({ result: { cutout: CUTOUT }, source: 'ai' });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({ wantImage: true, images: [SHOT], effort: 'low' });
  });

  it('never asks for a second image, whatever the reply text says', async () => {
    const transport = new MockTransport(() => ({ json: { surprise: [1, 2] }, image: CUTOUT }));
    const out = await runTask(
      removeBackgroundTask,
      { image: SHOT },
      { transport, provider: codex, confirmImages },
    ).done;
    expect(out.source).toBe('ai');
    expect(transport.calls).toHaveLength(1);
  });

  it('is locked for a provider that cannot return an image, without calling it', async () => {
    const transport = new MockTransport([{ image: CUTOUT }]);
    const out = await runTask(
      removeBackgroundTask,
      { image: SHOT },
      { transport, provider: { name: 'claude', capabilities: ['image-in'] }, confirmImages },
    ).done;
    expect(out).toMatchObject({
      result: { cutout: null },
      source: 'fallback',
      notice: { kind: 'Locked' },
    });
    expect(transport.calls).toHaveLength(0);
  });

  it('ends on Protocol after one call when the provider returns no image', async () => {
    const transport = new MockTransport(() => ({ json: 'done' }));
    const out = await runTask(
      removeBackgroundTask,
      { image: SHOT },
      { transport, provider: codex, confirmImages },
    ).done;
    expect(out).toMatchObject({
      result: { cutout: null },
      source: 'fallback',
      notice: { kind: 'Protocol' },
    });
    expect(transport.calls).toHaveLength(1);
  });

  it('keeps the image as it was when the user does not confirm sending it', async () => {
    const transport = new MockTransport([{ image: CUTOUT }]);
    const out = await runTask(
      removeBackgroundTask,
      { image: SHOT },
      { transport, provider: codex, confirmImages: () => Promise.resolve(false) },
    ).done;
    expect(out).toMatchObject({ result: { cutout: null }, notice: { kind: 'Cancelled' } });
    expect(transport.calls).toHaveLength(0);
  });

  it('keeps the NoImage kind of the transport', async () => {
    const transport = new MockTransport([{ error: 'NoImage' }, { image: CUTOUT }]);
    const out = await runTask(
      removeBackgroundTask,
      { image: SHOT },
      { transport, provider: codex, confirmImages },
    ).done;
    expect(out).toMatchObject({ source: 'fallback', notice: { kind: 'NoImage' } });
    expect(transport.calls).toHaveLength(1);
  });
});
