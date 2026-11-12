## Summary

<!-- What changes and why. Add a screenshot or a short video for UI changes. -->

## How to test

<!-- Steps a reviewer can follow. Say which checks you ran and what you tried in the app. -->

## Related issues

<!-- Use "Fixes #123" to close an issue on merge. -->

## Checklist

- [ ] The PR title uses `type: description` or `type(scope): description`, such as `fix(capture): keep the DPI scale per monitor`.
- [ ] I reviewed this change and take responsibility for it.
- [ ] I ran the checks that match the changed files ([validation](https://github.com/phuscth/Cropa/blob/main/AGENTS.md#validation)) and listed the results above.
- [ ] New tests would catch a real regression ([test policy](https://github.com/phuscth/Cropa/blob/main/AGENTS.md#tests)), or none are needed.
- [ ] UI strings are in both `en.json` and `vi.json`.
- [ ] No keys, credentials, real screenshots of other people or private content in code, tests, fixtures, logs or screenshots.
- [ ] A new dependency or binary is not GPL/AGPL and is listed in `THIRD_PARTY_NOTICES.md` when it ships.
- [ ] Changes to capabilities, commands, the CSP, process spawning or `cropa-agent` are called out in the summary.
