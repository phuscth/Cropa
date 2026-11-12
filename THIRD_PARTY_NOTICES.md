# Third-party notices

Cropa is MIT-licensed. This file lists third-party components that are
**bundled with or downloaded by** Cropa and are not ordinary npm or crates.io
dependencies (those are checked automatically by `cargo-deny` and
`pnpm check:licenses` in CI).

For models, both the licence of the code and the licence of the weights are
recorded.

| Component | Used for | Licence (code) | Licence (weights) | Shipped how |
|---|---|---|---|---|
| Microsoft Edge WebView2 Runtime | App UI | Microsoft software licence | n/a | Installed by the NSIS bootstrapper if missing |

Planned entries (added when the feature that uses them lands): an ffmpeg LGPL
build, and the `gif` and `quantette` crates.
