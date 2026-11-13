import type { Capability } from '@cropa/ai';
import type { TFunction } from 'i18next';

import type { AiDetection, AiProvider } from '../../lib/bindings.ts';

/** Where a provider stands: what the user must do before Cropa can use it. */
export type CliStatus = 'unavailable' | 'notInstalled' | 'notLoggedIn' | 'ready';

/**
 * `unavailable`: Cropa has no adapter for it in this build. An unknown login
 * counts as ready; a run then reports `NotLoggedIn` if it is not.
 */
export function cliStatus(detection: AiDetection): CliStatus {
  if (!detection.available) return 'unavailable';
  if (detection.installed === false) return 'notInstalled';
  if (detection.loggedIn === false) return 'notLoggedIn';
  return 'ready';
}

export function capabilitiesOf(detection: AiDetection): Capability[] {
  const capabilities: Capability[] = [];
  if (detection.imageIn) capabilities.push('image-in');
  if (detection.imageOut) capabilities.push('image-out');
  return capabilities;
}

export interface ListedProvider {
  provider: AiProvider;
  detection: AiDetection;
}

/** The providers to offer: Codex and Claude Code, plus the mock in development builds. */
export function listProviders(detections: readonly AiDetection[], dev: boolean): ListedProvider[] {
  const offered: AiProvider[] = dev ? ['codex', 'claude', 'mock'] : ['codex', 'claude'];
  return offered.flatMap((provider) => {
    const detection = detections.find((d) => d.provider === provider);
    return detection ? [{ provider, detection }] : [];
  });
}

/** The name shown to the user. */
export function providerName(t: TFunction, provider: AiProvider): string {
  return t(`ai.provider.${provider}`);
}

/** Who receives what a task sends. */
export function vendorName(t: TFunction, provider: AiProvider): string {
  return t(`ai.vendor.${provider}`);
}
