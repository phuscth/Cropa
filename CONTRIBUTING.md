# Contributing to Cropa

Thanks for helping. The plan and the decisions already made live in
[ROADMAP.md](ROADMAP.md); please read §2 (decisions) and §4 (engineering
standards) before a larger change.

## Setup

See [README.md](README.md#develop). `pnpm i && pnpm dev` should open the app
from a clean clone.

## Before you open a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

CI runs the same steps on `windows-latest`, plus `cargo-deny` and the npm
licence check.

## Rules that are easy to miss

- **Commands are typed.** Add a Rust command with `#[tauri::command]` and
  `#[specta::specta]`, register it in `specta_builder()` (`src-tauri/src/lib.rs`)
  **and** in `build.rs`, then grant `allow-<command>` only in the capabilities
  of the windows that need it. Run `pnpm dev` once to regenerate
  `src/lib/bindings.ts` and commit it; `cargo test` fails if it is stale.
  Never call `invoke` with a hand-written string.
- **UI strings go through i18n** (`apps/desktop/src/lib/i18n/en.json` and
  `vi.json`, same keys). Tray strings live in `src-tauri/src/i18n.rs`.
- **Errors shown to users have three parts:** what happened, why, what to do next.
- **No GPL/AGPL dependencies.** Record any new external model or binary, with
  the licence of both code and weights, in `THIRD_PARTY_NOTICES.md`.
- **No telemetry**, and logs never contain image content or prompts.
- **New decisions** get a short ADR in `docs/decisions/` and a row in ROADMAP §2.
- Data written to disk carries a `version` and goes through a migrate function.

## Commits

Small, focused commits with a message that says why. One logical change per PR.
