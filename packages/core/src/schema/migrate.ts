import type { z } from 'zod';

export type MigrateError =
  /** `issues` read "path.to.field: message". */
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'too-new'; version: number; supported: number };

export type MigrateResult<T> = { ok: true; value: T } | { ok: false; error: MigrateError };

/** Upgrades a document of one version to the next. */
export type UpgradeStep = (input: Record<string, unknown>) => Record<string, unknown>;

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return `${path === '' ? '(root)' : path}: ${issue.message}`;
  });
}

/** Puts `prefix` in front of the path of an issue made by {@link formatIssues}. */
export function prefixIssue(prefix: string, issue: string): string {
  return issue.startsWith('(root): ')
    ? `${prefix}: ${issue.slice('(root): '.length)}`
    : `${prefix}.${issue}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks the `version` of `input` and runs the upgrade steps from that version
 * to `current`. `steps[v]` upgrades version `v` to `v + 1`.
 */
export function upgrade(
  input: unknown,
  current: number,
  steps: Readonly<Record<number, UpgradeStep>>,
): MigrateResult<Record<string, unknown>> {
  if (!isRecord(input)) {
    return { ok: false, error: { kind: 'invalid', issues: ['(root): expected an object'] } };
  }
  const version = input.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      error: { kind: 'invalid', issues: ['version: expected a positive integer'] },
    };
  }
  if (version > current) {
    return { ok: false, error: { kind: 'too-new', version, supported: current } };
  }
  let doc = input;
  for (let v = version; v < current; v += 1) {
    const step = steps[v];
    if (!step) {
      return {
        ok: false,
        error: { kind: 'invalid', issues: [`version: no upgrade from version ${v}`] },
      };
    }
    doc = { ...step(doc), version: v + 1 };
  }
  return { ok: true, value: doc };
}

export function parseWith<T>(schema: z.ZodType<T>, doc: unknown): MigrateResult<T> {
  const parsed = schema.safeParse(doc);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: { kind: 'invalid', issues: formatIssues(parsed.error) } };
}
