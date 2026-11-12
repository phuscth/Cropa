# Cropa

Commands and setup are in [README](README.md#develop), checks and PR rules in [CONTRIBUTING](CONTRIBUTING.md).

## Rules

- Do not push, publish a release or post on GitHub without explicit authorization.
- Everything in the repository is in English: code, comments, docs, commit messages and pull requests. The one exception is the Vietnamese translation of the UI (`vi.json`, the Vietnamese strings in `i18n.rs`).
- Keep keys, credentials, screenshots of real users and private content out of Git, logs, prompts and test fixtures.
- Never read, copy or store `~/.claude/.credentials.json` or `~/.codex/auth.json`, in the product or while developing it.
- No telemetry. Logs never hold image content or prompts.
- No GPL or AGPL dependencies. A new external binary or model goes in `THIRD_PARTY_NOTICES.md` with the licence of its code and weights.
- UI strings go through i18n: `apps/desktop/src/lib/i18n/en.json` and `vi.json` with the same keys, tray and native overlay strings in `src-tauri/src/i18n.rs`. A user-facing error says what happened, why, and what to do next.
- Simple first: no option, cache or parallel path without a measurement or a real request.
- Plans, research, decision notes, prototypes and review notes stay out of the repository. Code comments explain the code without pointing at them.
- Data written to disk carries a `version` and goes through a migrate function.

## Architecture

What a module must not do is as binding as what it does.

- `packages/core` (`@cropa/core`): versioned zod schema, the one renderer `render(scene, t, ctx)`, colour, export presets. No Tauri, no network, no DOM outside Canvas. Preview, PNG export and every video frame go through that renderer.
- `packages/ai` (`@cropa/ai`): AI tasks (prompt, schema, validate, retry, fallback) and evals. Knows a provider only by name and spawns nothing.
- `packages/ui` (`@cropa/ui`): shadcn components, display only.
- `apps/desktop/src`: windows (one Vite entry each), state, wiring UI to core, ai and the typed commands. Draws images only through core's renderer.
- `apps/desktop/src-tauri`: a thin Rust layer. Everything that differs by operating system stays behind the `Platform` trait in `platform/`. Rust works in physical pixels; conversion to logical units happens only at the UI edge.
- `crates/cropa-agent`: detects the user's Codex or Claude Code CLI, runs one turn, cancels, returns the output image. Knows nothing about backgrounds or prompts.
- `crates/cropa-gif`, `crates/cropa-matte`: pure algorithms on buffers, no Tauri.

## Safety invariants

- Commands are typed: `#[tauri::command]` plus `#[specta::specta]`, registered in `specta_builder()` (`src-tauri/src/lib.rs`) and in `build.rs`. `pnpm bindings` regenerates `src/lib/bindings.ts`, which is committed; `cargo test` fails when it is stale. Never call `invoke` with a hand-written string.
- Each window has its own capability with only the permissions it uses; grant `allow-<command>` only where a window calls it.
- The WebView never spawns a process and has no shell permission. Every outside command runs in Rust with a fixed path and fixed arguments.
- The CSP is strict and loads no outside script. A downloaded file matches the SHA-256 in its manifest before use.
- Cropa runs only the CLI the user installed and logged in to: it never bundles, installs, patches or proxies it, and never reads or stores its login.

## Validation

Run only the checks needed for the files and behaviour changed. Documentation changes need no application checks.

- TypeScript: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Rust: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`. `tauri::generate_context!` embeds the frontend, so a fresh clone or worktree runs `pnpm i` and `pnpm --filter @cropa/desktop build` first.
- A changed command: `pnpm bindings`. A changed npm dependency: `pnpm check:licenses`.
- `pnpm dev` runs the app (Vite on port 1420, single instance, so only one at a time). `pnpm tauri build` builds the NSIS installer and takes minutes; run it only for packaging, startup or tray changes.

Report which checks ran and which behaviour was tried in the app, separately.

## Tests

Keep tests that would catch a real regression: core schema and migrations, the renderer (image snapshots), AI task validation and fallback, `cropa-agent` transport against recorded CLI output, the algorithms in the crates, and the translation key and placeholder checks. No tautological tests, mocks that return what they were told, or tests of copy, CSS or constants. Extend the existing test file for an area instead of adding one.
