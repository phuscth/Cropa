import { z } from 'zod';

import type { JsonSchema } from './transport.ts';

/** What a provider can do beyond answering text. */
export type Capability = 'image-in' | 'image-out';

export interface Provider {
  name: string;
  capabilities: readonly Capability[];
}

export interface TaskPrompt {
  system: string;
  user: string;
  images?: readonly string[];
}

export interface TaskDefinition<I, S extends z.ZodType, T> {
  id: string;
  /** Bump it when the prompt changes, so eval reports stay comparable. */
  version: number;
  schema: S;
  requires: readonly Capability[];
  timeoutMs?: number;
  buildPrompt(input: I): TaskPrompt;
  postprocess(output: z.output<S>, ctx: { input: I; image?: string }): T;
  /** A deterministic answer that needs no AI. */
  fallback(input: I): T;
}

export interface Task<I, S extends z.ZodType, T> extends TaskDefinition<I, S, T> {
  readonly jsonSchema: JsonSchema;
}

export function defineTask<I, S extends z.ZodType, T>(
  def: TaskDefinition<I, S, T>,
): Readonly<Task<I, S, T>> {
  if (def.id.trim() === '') throw new Error('task id must not be empty');
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`task ${def.id}: version must be a positive integer`);
  }
  // The CLI sees the shape it has to produce, so describe the input side.
  const jsonSchema = z.toJSONSchema(def.schema, { io: 'input' });
  return Object.freeze({ ...def, jsonSchema });
}
