# Cropa screenshot

**C**apture · **R**ender · **O**verlay · **P**olish · **A**I

Open-source (MIT) screenshot tool that beautifies captures, with optional AI
features. Windows only for now; macOS if sponsored. Status: **Phase 0 (foundation)**; see
[ROADMAP.md](ROADMAP.md).

## Develop

Requirements: Node 22+, pnpm 11, Rust stable (MSVC toolchain), Visual Studio
Build Tools with the C++ workload, WebView2 (preinstalled on Windows 11).

```bash
pnpm i
pnpm dev
```

Cropa starts in the system tray. Press `Alt+Shift+S` or use the tray menu.

| Command | What it does |
|---|---|
| `pnpm dev` | Run the desktop app with hot reload |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | ESLint, `tsc -b`, Vitest |
| `cargo clippy --workspace --all-targets -- -D warnings` | Rust lint |
| `cargo test --workspace` | Rust tests (also checks `bindings.ts` is fresh) |
| `pnpm tauri build` | NSIS installer in `target/release/bundle/nsis/` |
| `pnpm bindings` | Regenerate `apps/desktop/src/lib/bindings.ts` from the Rust commands |
| `pnpm check:licenses` | Block disallowed npm licences |

## Layout

```
apps/desktop        Tauri 2 app (React + TS in src/, Rust in src-tauri/)
packages/core       @cropa/core: schema, renderer, colour, export presets
packages/ai         @cropa/ai: AI tasks, validation, evals
packages/ui         @cropa/ui: shadcn/ui components
packages/config     shared tsconfig, ESLint, Tailwind tokens
crates/cropa-agent  drives the user's Codex / Claude Code CLI
crates/cropa-gif    animated GIF writer
crates/cropa-matte  background removal: applies the AI cut-out's alpha to the original
docs/decisions      ADRs
```

## License

[MIT](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
