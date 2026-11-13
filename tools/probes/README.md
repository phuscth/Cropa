# CLI probes

Small Node scripts that run the user's installed Codex CLI (`codex exec`) and
Claude Code (`claude -p`) with fixed arguments, one question per script, and
record what they really do. They exist so the two `cropa-agent` adapters are
written against measured behaviour, and so the measurements can be repeated
when a CLI version changes.

Every script that sends a prompt **spends real quota on your account**. Prompts
are tiny, but keep runs few.

## Before you run

- Windows, Node 24, `codex` and `claude` installed, in `PATH` and logged in.
- Run from the repository root. Nothing else is needed: the scripts use only
  Node's standard library.
- Each turn runs in a fresh empty folder under `%TEMP%`, deleted afterwards,
  with an allowlisted environment (`PATH`, `SystemRoot`, `USERPROFILE`,
  `APPDATA`, `TEMP` and a few others). Variables such as `ANTHROPIC_*`,
  `CLAUDE_CODE_*` or `OPENAI_*` from your shell never reach the CLI.
- `%TEMP%` must not be inside a git repository (on some machines the whole
  user profile is one). The scripts refuse to start if it is: set `TEMP` and
  `TMP` to another folder for the shell that runs them.
- The scripts never read `~/.codex` or `~/.claude`, and never edit them.

## Scripts

| Script | Quota | What it answers |
|---|---|---|
| `auth.mjs` | none | `--version`, `codex login status`, `claude auth status`, logged in and logged out (empty `CODEX_HOME` / `CLAUDE_CONFIG_DIR`) |
| `flags.mjs` | none | Does each locked-down flag parse? Runs with an empty stdin, so the CLI stops before any request |
| `schema.mjs <cli> [ok\|loose\|invalid]` | 1 turn | Where forced JSON lands in the stream, and how a schema the CLI rejects fails |
| `latency.mjs <cli> [runs] [--minimal]` | `runs` turns | Cold latency of a background-sized, schema-constrained turn: first event, final event, exit; p50 and p95 |
| `image.mjs <cli>` | 1 turn | Image in: `codex exec -i <png>`, or a base64 image block in Claude Code's stream-json input |
| `bait.mjs <cli> <variant> [--global-heading <text>]… [--sources]` | 1 turn | Which flags keep instruction files, skills, plugins and tools out of a turn |
| `cancel.mjs <cli> tree\|root` | part of a turn | Killing a turn mid-stream: what is left running afterwards |
| `scrub.mjs <raw> <fixture>` | none | Turns a raw stream into a fixture safe to commit |

`<cli>` is `codex` or `claude`. `lib.mjs` holds the shared runner, the
environment allowlist, the request and the locked-down flag sets; `turn.mjs`
runs one turn of either CLI.

### Bait

`bait.mjs` writes a project instruction file (`AGENTS.md` or `CLAUDE.md`) with
a marker token into the temp folder, then asks the model to list the headings
of every instruction file it was given. Your global files are not touched:
pass a heading that only your global `~/.codex/AGENTS.md` or
`~/.claude/CLAUDE.md` contains with `--global-heading`, and the script reports
whether the model saw it. `--sources` asks instead for every skill, plugin,
app, MCP server and tool in the turn.

## Output

Each run writes to `tools/probes/out/` (gitignored):

- `<time>-<label>.stdout.jsonl`: the raw event stream, one event per line;
- `<time>-<label>.stderr.txt`;
- `<time>-<label>.meta.json`: arguments, exit code and the arrival time of every line;
- `latency-<cli>-summary-<n>.json`: per-run timings with p50 and p95.

Raw output holds your account email, ids and paths. Never commit it: run
`scrub.mjs` and commit the result under `crates/cropa-agent/tests/fixtures/`.
The console output of the scripts masks emails, UUIDs and your home folder.
