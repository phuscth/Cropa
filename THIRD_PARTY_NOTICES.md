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
| [n8n-io/nod](https://github.com/n8n-io/nod) theme | Colour tokens, radii, shadows and easing curves in `packages/config/tailwind.css` | Apache-2.0 | n/a | Values adapted from its `src/web/theme.css` and changed for Cropa; compiled into the app's CSS |

Planned entries (added when the feature that uses them lands): an ffmpeg LGPL
build, and the `gif` and `quantette` crates.

## n8n-io/nod

Copyright 2026 n8n GmbH. Licensed under the
[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0).
Its NOTICE file reads: "This product includes software developed at n8n GmbH
(https://n8n.io/)." Cropa adapts only the theme values listed above, not nod's
components or any other file.
