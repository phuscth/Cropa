# Contributing to Cropa

Thanks for helping. For anything larger than a small fix, open an issue first
so we can agree on the approach. [AGENTS.md](AGENTS.md) lists the module
boundaries and the rules every change follows.

## Setup

See [README.md](README.md#develop). `pnpm i && pnpm dev` should open the app
from a clean clone.

`pnpm i` also installs the git hooks ([lefthook](lefthook.yml)): on commit,
`rustfmt` formats staged Rust files and [gitleaks](https://github.com/gitleaks/gitleaks)
scans for secrets when it is on your `PATH`
(`winget install --id Gitleaks.Gitleaks --version 8.30.1 --exact`); on push,
`pnpm lint` runs. CI scans for secrets again.

Working with a coding agent? [AGENTS.md](AGENTS.md) holds the rules it follows here.

## Before you open a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check:presets
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

CI runs the same steps on `windows-latest`, plus `cargo-deny` and the npm
licence check.

## E2E smoke tests

Two smoke tests drive the real app on Windows. The capture test presses the
capture key, drags a region and checks the clipboard image, the preview, and that
Esc leaves the clipboard alone. The editor test opens a fixture image, checks
the preview canvas shows it, picks a background preset, presses `Ctrl+S` and
checks the saved PNG.

CI runs only the capture test (`.github/workflows/e2e.yml`). Run the editor test
by hand before a release: on GitHub's Windows runners WebDriver cannot attach to
WebView2.

One-time setup for the editor test:
`cargo install tauri-driver --version 2.0.6 --locked`. The editor
test downloads the `msedgedriver` that matches your WebView2 into `target/e2e/`
on first run, picked from a table of known versions in `e2e/msedgedriver.mjs`
and checked against its SHA-256. When WebView2 reaches a major version the table
lacks, the test says which version to add with its hash.

Run `pnpm e2e`, or `pnpm e2e:build` and then `pnpm e2e:capture` and/or
`pnpm e2e:editor`. They move the mouse, press keys and replace the clipboard, so
leave the machine alone while they run. They start a separate instance
(`cropa-e2e`) with its data in a temp folder (WebView data in
`%LOCALAPPDATA%\cropa-e2e`) and the capture key `Ctrl+Alt+Shift+F9`, so an
open Cropa can stay open and its data, settings and start-with-Windows entry are
untouched. The E2E build goes to `target/e2e-app`, so the first build takes a
while but normal builds never overwrite it. Only debug builds read the hook.

## Background presets

A background preset is one JSON file in [`presets/`](presets/). The format, the
rules and the steps to add one are in [`presets/README.md`](presets/README.md).

## Background code sandbox

AI-written background code runs only in `apps/desktop/src/features/code-sandbox/`:
a hidden `srcdoc` iframe with `sandbox="allow-scripts"` (opaque origin, never
`allow-same-origin`) and its own CSP `default-src 'none'`, with the code in a blob
Worker inside it. The code gets only `t` and the scene, and draws on canvases
(2D, or WebGL with the bundled three.js). The two app CSP exceptions in
`tauri.conf.json` (`worker-src blob:` and the bootstrap's SHA-256 in `script-src`)
exist only for it.

Whenever `BOOTSTRAP_SCRIPT` changes, update `BOOTSTRAP_CSP_HASH` and the hash in
`tauri.conf.json`; the test in `sandbox.test.ts` fails otherwise.

Before a release, check the escape surface by hand: open the main window's
devtools with a test module loaded and try each of these. Every one must fail or
be undefined, and nothing may reach the network.

- From the worker: `fetch` (same origin, another origin, `http://ipc.localhost`),
  `XMLHttpRequest`, `WebSocket`, `importScripts`, `eval` and `new Function`,
  `indexedDB`, a `BroadcastChannel` shared with the app, `typeof __TAURI_INTERNALS__`,
  `typeof document`.
- From the iframe document: `parent.document`, `localStorage`,
  `typeof __TAURI_INTERNALS__`.
- A module with `for(;;){}` times out and the editor stays responsive.
- A module that allocates memory until it fails, and one that floods `postMessage`
  from a `setInterval`: the editor stays responsive. In Task Manager, check that
  the sandboxed frame runs in its own WebView2 process. The runner closes every
  bitmap it did not ask for and recreates the sandbox after 16 unexpected
  messages in one request, so a flood ends as `sandbox-failed`.

## Rules that are easy to miss

- **Commands are typed.** Add a Rust command with `#[tauri::command]` and
  `#[specta::specta]`, register it in `specta_builder()` (`src-tauri/src/lib.rs`)
  **and** in `build.rs`, then grant `allow-<command>` only in the capabilities
  of the windows that need it. Run `pnpm bindings` to regenerate
  `src/lib/bindings.ts` (no window opens) and commit it; `cargo test` fails if
  it is stale.
  Never call `invoke` with a hand-written string.
- **UI strings go through i18n** (`apps/desktop/src/lib/i18n/en.json` and
  `vi.json`, same keys). Tray strings live in `src-tauri/src/i18n.rs`.
- **Errors shown to users have three parts:** what happened, why, what to do next.
- **No GPL/AGPL dependencies.** Record any new external model or binary, with
  the licence of both code and weights, in `THIRD_PARTY_NOTICES.md`.
- **No telemetry**, and logs never contain image content or prompts.
- Data written to disk carries a `version` and goes through a migrate function.

## Commits

Small, focused commits with a message that says why. One logical change per PR,
with a [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
title such as `fix(capture): keep the DPI scale per monitor`, and the PR
template filled in.
