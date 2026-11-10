# Contributing to OnDemand for X

Thank you for helping. Bug reports with a **Diagnostics** text, translations and real-device test reports are the most useful contributions.

## Quick start

```bash
npm install
npx playwright install chromium
npm run check          # locale check + build + the whole test suite
```

Node 18+ builds the packages (`node tools/build.js`, no dependencies). The tests need Playwright's Chromium. If you already have a Chromium, point the tests at it with `XOD_CHROME=/path/to/chrome`; `XOD_PLAYWRIGHT=/path/to/playwright` picks another Playwright install. `node test/run-tests.cjs parked` runs only the tests whose name contains "parked".

## Layout

```
src/hook.js        runs inside X's page: parks / releases the next-page request
src/content.js     chip, panel, settings, diagnostics
src/content.css    styles (every id and class starts with xod-)
locales/*.json     interface texts, one file per language
icons/             extension icons
tools/             build.js (packages), check-locales.js, lib/
test/              run-tests.cjs, mock-x.html (simulated X), feed-gen.js (fake GraphQL server)
docs/              HOW-IT-WORKS.md, BETA-TESTING.md, RELEASING.md
```

[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) explains the mechanism and the design rules.

## Rules the code follows

1. **Fail open.** If anything is unexpected, X must behave as if the extension were not installed. An error of the extension must never reach X's code (the one thing X can notice is a parked `fetch` that it aborts itself). Never leave a request parked without a way for the person to release it: the button, switching the extension off, and the valves described in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).
2. **No network of its own, no remote code, no analytics.** `tools/build.js` fails the build on `eval`, `new Function`, `sendBeacon`, `WebSocket`, `innerHTML`, unexpected URLs and so on.
3. **No new permissions** (currently only `storage`) and no wider site access without a very good reason, a change in `PRIVACY.md` and in the store texts. The build checks the permission list on purpose.
4. **No dependencies in the extension.** Plain JavaScript, no framework, no bundler.
5. **Small and quiet.** Nothing redraws or loops while the page is idle (there is a test for it). The only timers are a light check every 0.4 s for navigation and dialogs (it does nothing in a background tab) and, only while something is parked or loading, a look-after timer in the hook that stops by itself. The interface must not cover X's own controls.

## Making a change

1. Write a **failing test first** when you can (the simulated X in `test/mock-x.html` has switches for many layouts; add one if you need one).
2. Change the code in `src/` (or `locales/`).
3. `npm run check` must pass. It builds the packages and runs them as real extensions.
4. Add a line to the *Unreleased* part of [CHANGELOG.md](CHANGELOG.md).
5. Open a pull request and fill in the checklist.

The version number lives in `package.json` and in the `VERSION` constants of `src/hook.js` and `src/content.js`; the build refuses to run when they disagree.

## Translations

The interface has about two dozen short texts. To add a language:

1. Copy `locales/en.json` to `locales/<code>.json` (a short language code such as `de` or `pt`).
2. Translate **every value**. Keep the keys. `_name` is the language's name *in that language* (it appears in the picker), `_dir` is `ltr` or `rtl`.
3. `npm run check:locales` tells you what is missing, what is too long (the status texts have to fit in a small chip on a 320 px phone: at most 30 characters; other limits are in `tools/lib/i18n.js`) and whether a text contains markup (texts are plain text only).
4. `npm test` includes your language automatically: it checks direction, that every text appears, and that everything fits at 320 px and 412 px.

To correct an existing translation, edit its file and run the same checks. If you are a native speaker, please say so in your pull request. English is the reference and Arabic is the author's own language; **every other language** (German, Spanish, French, Indonesian, Japanese, Korean, Portuguese (Brazil), Russian, Thai, Turkish, Simplified and Traditional Chinese) was drafted with AI assistance and has **not** been reviewed by native speakers yet.

Tone: short, plain and friendly. "Batch" means *one load of posts*; pick a natural word, not a technical one.

## When X changes something

See "When X changes something" in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md): get the Diagnostics text, find what no longer matches, make a failing test, fix, `npm run check`.

## Reporting bugs

Use the issue form and paste the **Diagnostics** text (settings → *Diagnostics* → *Copy*). It contains no posts and no account data. Please also tell us the browser, device and what you saw.

## Conduct

Be kind and patient; assume good faith. Harassment or abuse is not tolerated and may lead to removal from the project.
