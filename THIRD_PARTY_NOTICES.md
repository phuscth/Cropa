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
| Inter typeface (via @fontsource/inter 5.3.0 and @fontsource-variable/inter 5.3.0) | App UI text (the variable font, weights 100 to 900) and the text and step numbers the renderer draws on images (the static files) | OFL-1.1 | n/a | WOFF2 files (Latin, Latin Extended, Vietnamese and further subsets; static weights 600 and 700, and the variable-weight font) bundled into the app by Vite |
| [three.js](https://threejs.org) 0.187.0 | 3D in AI-written backgrounds | MIT | n/a | Bundled into the app as a classic script and loaded only into the background sandbox worker |

Planned entries (added when the feature that uses them lands): an ffmpeg LGPL
build, and the `gif` and `quantette` crates.

## Inter

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter). Licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). The font files are unmodified subsets as published by Fontsource.

## three.js

Copyright © 2010-2026 three.js authors. Licensed under the MIT License. The build is the unmodified `three.module.js` of 0.187.0 bundled as a classic script by Vite.
