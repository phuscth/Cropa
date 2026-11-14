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
| `claude/stream-partial-thinking.jsonl` | node probe script, 2026-11-14 | Locked-down turn with `--include-partial-messages --thinking-display=summarized`, effort high, `--json-schema`: `stream_event` lines with `thinking_delta` chunks of summarized thinking and `input_json_delta` chunks of the structured answer, then the full messages and `result` |
| `claude/stream-partial-text.jsonl` | node probe script, 2026-11-14 | Same flags without `--thinking-display`, effort medium: `text_delta` chunks for a short prose line, then `input_json_delta` chunks; no thinking |
| `claude/initialize-models.jsonl` | node probe script, 2026-11-14, Claude Code 2.1.325 | `control_request` `initialize` on stdin with no user message: one `control_response` whose `response.response.models` lists the model aliases and full names, then the CLI exits 0. Only `models` is kept; the account and session fields are removed |
| `codex/app-server-model-list.jsonl` | node probe script, 2026-11-14, codex-cli 0.167.0 | `codex app-server` with `initialize`, `initialized`, `model/list` on stdin (kept open): the `initialize` result, two notifications, then the `model/list` result. Only the listed model fields are kept; the initialize result and the notifications are emptied of paths, machine name and installation id |
| `codex/exec-reasoning-summary.jsonl` | node probe script, 2026-11-14 | `-c model_reasoning_summary="auto"`, effort low: an `item.completed` reasoning item with a short markdown title, then the `agent_message`, then `turn.completed`; Codex sends each item whole, with no partial text |
| `codex/exec-image-generation-ok.jsonl` | node probe script, 2026-11-14, codex-cli 0.167.0 | Image generation turn (`image_generation` left enabled, input picture attached): `thread.started`, `turn.started`, two `agent_message` items, `turn.completed`. The stream never names the output file: the PNG lands under the Codex home in `generated_images/<thread id>/` and is not in the stream. The thread id is replaced by a placeholder |
