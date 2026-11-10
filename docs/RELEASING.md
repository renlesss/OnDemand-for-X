# Releasing

## Checklist

1. **Version.** Change it in `package.json` **and** in the `VERSION` constants of `src/hook.js` and `src/content.js` (the build refuses to run when they disagree).
2. **Changelog.** Move *Unreleased* to the new version, with the date.
3. **Check.** `npm run check` — locale check, store-text check, build, and the full test suite including the built packages.
4. **Real device.** Install `dist/ondemand-for-x-<version>-chromium.zip` on a real phone and a desktop browser and run the ten-minute test in [BETA-TESTING.md](BETA-TESTING.md). Update the status table in both READMEs with what you really saw.
5. **Tag and release.** Either `git tag v<version> && git push --tags`, or, without a terminal, GitHub → *Actions* → *Release* → *Run workflow* on `main` (the tag is made from the version in `package.json`). The *Release* workflow builds, tests, and attaches the three zips and `SHA256SUMS.txt` to a GitHub release (notes come from `CHANGELOG.md`). Versions `0.x` and versions with a suffix (`1.0.0-rc1`) are marked **pre-release** automatically; `1.0.0` and later become the *latest* release. If the release for the tag already exists, the workflow attaches the built files to it instead of failing.
6. **Stores** (each is a manual step; the texts and pictures are in [`store/`](../store/README.md)):
   - **Microsoft Edge Add-ons** (Partner Center): upload `…-chromium.zip`; fields in [store/edge.md](../store/edge.md).
   - **Firefox Add-ons (AMO)**: run the package once in Firefox first ([store/firefox.md](../store/firefox.md)), then upload `…-firefox.zip` and, when asked for the source, `…-source.zip`. The build instructions are [BUILD.md](../BUILD.md) (also in the source zip); the build is deterministic. The add-on id is in `package.json` (`xod.geckoId`) and **must never change**.
   - Chrome Web Store is **not** used (it needs a paid developer registration).
7. **Announce** only after the stores have approved the new version (the launch plan is kept outside the repository).

## Pictures

Everything in `store/assets/`, `store/screenshots/`, `docs/img/` is generated from the simulated demo feed, so it can be redone after any UI change:

```bash
python3 tools/make_icons.py icons store/assets   # icons + the 300x300 store logo (needs Pillow)
node tools/screenshots.cjs                        # README images, store screenshots, promo tiles
node tools/demo-gif.cjs                           # the two demo animations (needs ffmpeg)
```

## Notes

- The first Firefox submission needs `data_collection_permissions` (already in the manifest: `required: ["none"]`). With `strict_min_version` 128 the validator may warn about it; see [store/firefox.md](../store/firefox.md) for what to do if the upload is refused.
- A permission change means: update `tools/build.js` (it checks the list on purpose), `PRIVACY.md`, the store permission explanations (`store/edge.md`) and the changelog — and expect a slower review and a permission prompt for existing users.
- Never commit key files (`.pem`, `.key`, `.crx`): the build refuses to put them in the source package, `.gitignore` excludes them.
- `homepage` in `package.json` becomes `homepage_url` in the manifest. It is left unset in the `0.9.x` pre-releases (they stay identical to the tested packages); set it to the repository address (`https://github.com/renlesss/OnDemand-for-X`) before the first store submission.
