import { describe, expect, it, vi } from 'vitest';

import { detectProviders } from './detect.ts';

describe('detectProviders', () => {
  it('shares one detection between callers while it is running, then starts a new one', async () => {
    let finish: (value: []) => void = () => undefined;
    const call = vi.fn(() => new Promise<[]>((resolve) => { finish = resolve; }));
    const first = detectProviders(call);
    const second = detectProviders(call);
    expect(call).toHaveBeenCalledTimes(1);
    finish([]);
    await Promise.all([first, second]);

    void detectProviders(call);
    expect(call).toHaveBeenCalledTimes(2);
    finish([]);
  });

  it('starts a new detection after one failed', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('ipc')).mockResolvedValueOnce([]);
    await expect(detectProviders(call)).rejects.toThrow('ipc');
    await expect(detectProviders(call)).resolves.toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
