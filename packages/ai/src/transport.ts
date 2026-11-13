export type JsonSchema = Record<string, unknown>;

export interface TransportRequest {
  system: string;
  prompt: string;
  schema: JsonSchema;
  /** Opaque references (paths the desktop side understands). */
  images: readonly string[];
  wantImage: boolean;
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
