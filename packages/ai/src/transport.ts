export type JsonSchema = Record<string, unknown>;

/** How much thinking a turn may spend. Higher is slower and uses more of the user's quota. */
export type Effort = 'low' | 'medium' | 'high';

export interface TransportRequest {
  system: string;
  prompt: string;
  schema: JsonSchema;
  /** Opaque references (paths the desktop side understands). */
  images: readonly string[];
  wantImage: boolean;
  /** Low when absent. */
  effort?: Effort;
  timeoutMs: number;
}

export interface TransportOutput {
  json?: unknown;
  /** Opaque reference to the returned image. */
  image?: string;
}

/** Progress reported by the CLI, passed through untouched. */
export type TransportEvent = { type: string } & Record<string, unknown>;

export interface TransportOptions {
  signal?: AbortSignal;
  onEvent?: (event: TransportEvent) => void;
}

/** Runs one turn against a provider. Rejects with `AgentError`. */
export interface Transport {
  run(req: TransportRequest, opts: TransportOptions): Promise<TransportOutput>;
}
