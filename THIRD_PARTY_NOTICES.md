# Third-party notices

Cropa is MIT-licensed. This file lists third-party components that are
**bundled with or downloaded by** Cropa and are not ordinary npm or crates.io
dependencies (those are checked automatically by `cargo-deny` and
`pnpm check:licenses` in CI).

For models, both the licence of the code and the licence of the weights are
recorded.

| Component | Used for | Licence (code) | Licence (weights) | Shipped how | Since |
|---|---|---|---|---|---|
| Microsoft Edge WebView2 Runtime | App UI | Microsoft software licence | n/a | Installed by the NSIS bootstrapper if missing | Phase 0 |

Planned entries (added when the phase that uses them lands): ffmpeg LGPL
build (Phase 7), `gif` and `quantette` crates (Phase 7c).
