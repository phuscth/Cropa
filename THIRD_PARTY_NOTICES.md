# Third-party notices

Cropa is MIT-licensed. This file lists third-party components that are
**bundled with or downloaded by** Cropa and are not ordinary npm or crates.io
dependencies (those are checked automatically by `cargo-deny` and
`pnpm check:licenses` in CI). The exception is an npm package whose artwork licence needs visible attribution.

For models, both the licence of the code and the licence of the weights are
recorded.

| Component | Used for | Licence (code) | Licence (weights) | Shipped how |
|---|---|---|---|---|
| Microsoft Edge WebView2 Runtime | App UI | Microsoft software licence | n/a | Installed by the NSIS bootstrapper if missing |
| Inter typeface (via @fontsource/inter 5.3.0 and @fontsource-variable/inter 5.3.0) | App UI text (the variable font, weights 100 to 900) and the text and step numbers the renderer draws on images (the static files) | OFL-1.1 | n/a | WOFF2 files (Latin, Latin Extended, Vietnamese and further subsets; static weights 600 and 700, and the variable-weight font) bundled into the app by Vite |
| [three.js](https://threejs.org) 0.187.0 | 3D in AI-written backgrounds | MIT | n/a | Bundled into the app as a classic script and loaded only into the background sandbox worker |
| [Solar Icons Set](https://www.figma.com/community/file/1166831539721848736) by 480 Design, via [@solar-icons/react](https://github.com/saoudi-h/solar-icons) 2.3.3 | UI icons | MIT (components); artwork CC BY 4.0 | n/a | Bundled into the app by Vite, only the icons used |
| [Lobe Icons](https://github.com/lobehub/lobe-icons) by LobeHub, `@lobehub/icons-static-svg` 1.102.0 | Anthropic and OpenAI marks naming the AI provider in the model picker, Settings and onboarding | MIT | n/a | Two SVG paths copied unmodified into `packages/ui/src/provider-logos.tsx`; the package is not a dependency |

Planned entries (added when the feature that uses them lands): an ffmpeg LGPL
build, and the `gif` and `quantette` crates.

## Inter

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter). Licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). The font files are unmodified subsets as published by Fontsource.

## three.js

Copyright © 2010-2026 three.js authors. Licensed under the MIT License. The build is the unmodified `three.module.js` of 0.187.0 bundled as a classic script by Vite.

## Solar Icons

The Solar Icons Set is by 480 Design (https://www.figma.com/community/file/1166831539721848736). The artwork is licensed under Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/); the React components of @solar-icons/react are MIT, Copyright 2024 Hakim Saoudi. The only change to the icons is the line width (stroke 2.25 instead of 1.5); they are otherwise unmodified. The credit and this note are shown in Settings > About.

## Lobe Icons

Lobe Icons by LobeHub (https://github.com/lobehub/lobe-icons), `@lobehub/icons-static-svg` 1.102.0. The Anthropic and OpenAI marks identify the AI providers in the model picker, Settings and onboarding. MIT, Copyright (c) 2023 LobeHub. The two SVG paths are copied unmodified into `packages/ui/src/provider-logos.tsx`. The marks are trademarks of Anthropic and OpenAI and are used only to name the provider the user runs. The credit is shown in Settings > About.
