import { commands, type AiDetection_Serialize } from '../../lib/bindings.ts';

type DetectCall = () => Promise<AiDetection_Serialize[]>;

let inFlight: Promise<AiDetection_Serialize[]> | undefined;

/**
 * Detects the AI providers. Callers that ask while a detection is running
 * share it (a component mounted twice, two components at once); a call after
 * it has settled starts a new one. `call` is for tests.
 */
export function detectProviders(call: DetectCall = () => commands.aiDetect()): Promise<AiDetection_Serialize[]> {
  if (inFlight) return inFlight;
  const running = call().finally(() => {
    if (inFlight === running) inFlight = undefined;
  });
  inFlight = running;
  return running;
}
