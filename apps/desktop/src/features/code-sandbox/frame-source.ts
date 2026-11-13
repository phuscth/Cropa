import { createCodeSandbox, type CodeFrame, type CodeSandboxOptions, type CodeScene } from './sandbox.ts';

/** A sandbox seen as a source of frames: load a module, render frames of it, dispose. */
export interface SandboxFrameSource {
  load(source: string): Promise<void>;
  renderFrame(t: number, scene: CodeScene): Promise<CodeFrame>;
  dispose(): void;
}

/** One sandbox behind the three calls the preview and export need. */
export function createSandboxFrameSource(options?: CodeSandboxOptions): SandboxFrameSource {
  const sandbox = createCodeSandbox(options);
  return {
    async load(source) {
      await sandbox.load(source);
    },
    renderFrame: (t, scene) => sandbox.renderFrame(t, scene),
    dispose: () => { sandbox.dispose(); },
  };
}
