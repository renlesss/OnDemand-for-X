# Building OnDemand for X from source

For store reviewers (Mozilla asks for the source and the build instructions) and for anyone who wants to check that a package matches the source.

## Environment

- Any OS with **Node.js 18 or newer** (developed and tested with Node 22 on Ubuntu 24.04).
- **No npm packages are needed to build.** Do not run `npm install`: it only installs Playwright, which the tests use (`npm test`), not the build.
- No network access is needed.

## Commands

```bash
node tools/build.js                      # everything
node tools/build.js --only firefox       # just the Firefox package
```

Output (all in `dist/`):

| File | What it is |
|---|---|
| `dist/firefox/` and `dist/ondemand-for-x-<version>-firefox.zip` | the Firefox package, the file uploaded to addons.mozilla.org |
| `dist/chromium/` and `dist/ondemand-for-x-<version>-chromium.zip` | the Chrome / Edge / Lemur package |
| `dist/ondemand-for-x-<version>-source.zip` | this source package |
| `dist/SHA256SUMS.txt` | SHA-256 of the three zips |

## What the build does to the sources

Nothing is minified, bundled, transpiled or obfuscated. The shipped files are the files in `src/`, apart from these steps:

1. `src/hook.js` → `hook.js`: the block between the markers `/* TEST-HOOKS-START */` and `/* TEST-HOOKS-END */` (it only lets the automated tests shorten three timeouts) is removed; the rest is copied unchanged.
2. `src/content.js` → `content.js`: the same two markers; the block between them (helpers only the automated tests use) is removed.
3. `src/content.css` → `content.css`: copied unchanged.
4. `locales/*.json` → `i18n.js`: the language files are validated and written as one JavaScript object (`tools/lib/i18n.js`).
5. `icons/icon{16,32,48,128}.png` and `LICENSE`: copied.
6. `manifest.json`: written by `tools/build.js` (the Firefox manifest additionally has `browser_specific_settings` and `host_permissions`).
7. The zip files are written by `tools/lib/zip.js` with a fixed file order and fixed timestamps, so **the build is deterministic**: building twice with the same Node.js version gives byte-identical zips. Another Node.js version can compress differently (zlib), so to compare two builds compare the files *inside* the zips (`unzip` both and run `diff -r`); their contents are identical.

The build also **fails** (see `checkCode` and `checkManifest` in `tools/build.js`) when the code uses `eval`, `new Function`, `innerHTML`, `sendBeacon`, `WebSocket`, `importScripts`, an unexpected URL or any permission other than `storage`, when the version numbers disagree, or when the manifest breaks a store rule (name and description length, gecko id, `data_collection_permissions`, …).

## Checking a package

```bash
sha256sum dist/ondemand-for-x-<version>-firefox.zip     # compare with SHA256SUMS.txt of the GitHub release
```

## Tests (optional)

`npm install && npx playwright install chromium && npm test` runs the automated tests in Chromium against a simulated X page, including the built packages loaded as real extensions. See [CONTRIBUTING.md](CONTRIBUTING.md).
