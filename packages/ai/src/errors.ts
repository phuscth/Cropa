/**
 * Error kinds a provider run can end with. Mirrors `AgentError` in the
 * `cropa-agent` crate (ROADMAP §3.3); keep both lists in step.
 */
export const AGENT_ERROR_KINDS = [
  'NotInstalled',
  'NotLoggedIn',
  'UsageLimit',
  'Timeout',
  'Protocol',
  'Cancelled',
] as const;

export type AgentErrorKind = (typeof AGENT_ERROR_KINDS)[number];

export function isAgentErrorKind(value: unknown): value is AgentErrorKind {
  return typeof value === 'string' && (AGENT_ERROR_KINDS as readonly string[]).includes(value);
}
