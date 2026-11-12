# Cropa screenshot

**C**apture · **R**ender · **O**verlay · **P**olish · **A**I

Open-source (MIT) screenshot tool that beautifies captures, with optional AI
features. Windows only for now; macOS if sponsored. Status: **early development**,
not released yet.

## Develop

Requirements: Node 22+, pnpm 11, [rustup](https://rustup.rs) with the MSVC
toolchain (the Rust version is pinned in `rust-toolchain.toml` and installed on
first build), Visual Studio Build Tools with the C++ workload, WebView2
(preinstalled on Windows 11).

```bash
pnpm i
pnpm dev
```

Cropa starts in the system tray. Press `Alt+Shift+S` or use the tray menu.

`pnpm i` also installs the git hooks from [lefthook.yml](lefthook.yml): `rustfmt`
and a [gitleaks](https://github.com/gitleaks/gitleaks) secret scan on commit,
lint on push. The secret scan runs when `gitleaks` is on your `PATH`.

| Command | What it does |
|---|---|
| `pnpm dev` | Run the desktop app with hot reload |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | ESLint, `tsc -b`, Vitest |
| `cargo fmt --all --check` | Rust formatting |
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
tools/              bindings generator, npm licence check
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The rules for code, checks and tests,
for people and coding agents alike, are in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
