# Recorded CLI output

Real output of `codex-cli 0.167.0` and Claude Code `2.1.323` on Windows,
recorded with `tools/probes/` and scrubbed with `tools/probes/scrub.mjs`:
emails, org, session, thread and message ids, signatures, temp folders, home
and other-drive paths, login expiry (`2030-01-01T00:00:00.000Z`), plan (`pro`)
and quota state (`utilization` 0.5, `resetsAt` 1893456000) are fixed
placeholders. Used by the transport contract tests.

| File | Recorded by | What it shows |
|---|---|---|
| `codex/exec-schema-ok.jsonl` | `latency.mjs codex` | Locked-down turn with `--output-schema`: the JSON is the `text` of the last `item.completed` `agent_message`, as a string |
| `codex/exec-schema-rejected.jsonl` | `schema.mjs codex loose` | A schema the API refuses: `error` then `turn.failed`, exit code 1 |
| `codex/exec-image-ok.jsonl` | `image.mjs codex` | `-i <png>`; answer `left=red right=blue` |
| `codex/exec-cancelled.jsonl` | `cancel.mjs codex tree` | Stream cut by a tree kill mid-turn: no final event |
| `codex/login-status-logged-in.stderr.txt` | `auth.mjs` | `codex login status`, exit 0; the text is on stderr, stdout is empty |
| `codex/login-status-logged-out.stderr.txt` | `auth.mjs` | Same with an empty `CODEX_HOME`, exit 1 |
| `claude/stream-schema-ok.jsonl` | `latency.mjs claude` | Locked-down turn with `--json-schema`: `init`, a `StructuredOutput` tool call, `rate_limit_event`, `result` with `structured_output` |
| `claude/stream-image-ok.jsonl` | `image.mjs claude` | Base64 image block in stream-json input; answer in `result.result` |
| `claude/stream-cancelled.jsonl` | `cancel.mjs claude root` | Stream cut mid-turn: no `result` |
| `claude/json-schema-invalid.stderr.txt` | `schema.mjs claude invalid` | `--json-schema` that is not a JSON Schema: refused before any request, exit 1, nothing on stdout |
| `claude/auth-status-logged-in.json` | `auth.mjs` | `claude auth status`, exit 0 |
| `claude/auth-status-logged-out.json` | `auth.mjs` | Same with an empty `CLAUDE_CONFIG_DIR`, exit 1 |
