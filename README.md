# Cropa screenshot

**C**apture · **R**ender · **O**verlay · **P**olish · **A**I

Cropa is an open-source screenshot tool that turns a plain capture into an image
ready to share: a background, a frame, a shadow and a few notes, in a couple of
clicks. It runs on Windows and lives in the system tray. Everything but the
optional AI features works offline.

Status: **early development**, not released yet. macOS support depends on
sponsorship.

## What it does

- **Capture.** Press `Alt+Shift+S` (or use the tray menu) and drag a region. You
  can also open, drop or paste an image you already have.
- **Beautify.** Pick a background preset or build your own from solid colours,
  linear, radial, conic and mesh gradients, or an image. Then adjust the frame
  style, corners, shadow, padding and aspect ratio, including sizes made for
  social platforms. Save the backgrounds you like as your own presets.
- **Annotate.** Arrows, rectangles, text and numbered steps, plus blur and
  pixelate to hide what should stay private.
- **AI backgrounds (optional).** Describe a background in the chat and Cropa
  asks the Codex or Claude Code CLI you already installed and signed in to. It
  never bundles, installs or signs in to either one, and the code the AI writes
  runs in a sandbox with no network access.
- **Export.** Copy to the clipboard, save as PNG, JPEG or WebP up to 6K, or drag
  the image straight into another app, a folder or a chat.
- **History.** Recent captures stay a click away, and you can turn history off.

Cropa sends no telemetry and needs no account. The interface is in English and
Vietnamese.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands and checks. The rules
for code, checks and tests, for people and coding agents alike, are in
[AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
