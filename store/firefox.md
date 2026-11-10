# Firefox Add-ons (addons.mozilla.org) — field by field

Publishing needs a Firefox account and no fee. Submit at <https://addons.mozilla.org/developers/> → *Submit a New Add-on* → **On this site** (listed).

**Before the first submission:** run the package once in Firefox (desktop: `about:debugging` → *This Firefox* → *Load Temporary Add-on* → pick `manifest.json` of `dist/firefox/`; steps in [docs/BETA-TESTING.md](../docs/BETA-TESTING.md)). The package has never been run in Firefox; the automated tests run in Chromium. **Do not submit before this smoke test has passed** (desktop at least, Firefox for Android if you can): open `x.com/home`, check that the chip says *active*, scroll to the end of the batch, check that the panel appears and that the button loads one batch. Also run `npx web-ext lint --source-dir dist/firefox` yourself (the build sandbox could not run the validator) and read the messages.

## 1. Upload

| Question | Answer |
|---|---|
| File | `ondemand-for-x-<version>-firefox.zip` |
| Platforms | Desktop and Android (the manifest declares `gecko_android`; Firefox 128 or newer) |
| Add-on id | `{24f7be2c-b1c0-431e-8156-8e07caa9203c}` — from `package.json` (`xod.geckoId`). **Permanent**: it can never change once the add-on exists. |
| Do you need to submit source code? | **Yes.** The build is not a bare copy: it removes the test-only blocks from `content.js` and `hook.js`, generates `i18n.js` from `locales/*.json` and writes the manifest. Nothing is minified or obfuscated, but Mozilla asks for source whenever a tool changes the files. |
| Source package | `ondemand-for-x-<version>-source.zip` (contains [BUILD.md](../BUILD.md) with the build instructions) |

The validator should report no errors. Read every warning; Mozilla advises fixing security and privacy warnings.

**About `data_collection_permissions`.** New add-ons must declare it since 3 November 2025 (Mozilla's add-ons blog); the manifest has `required: ["none"]`, because nothing is collected. Firefox 140 (desktop) and 142 (Android) are the versions that act on the key. Firefox 127 and older **reject** a manifest that contains it (a Mozilla Discourse answer), which is why `strict_min_version` is **128** (the first version with `"world": "MAIN"` content scripts, too); 128 to 139 ignore the key, which is harmless here. A community report says the validator may print a **warning** when the key is combined with a `strict_min_version` below 140; I could not confirm that, and I do not know whether AMO's upload step treats it as more than a warning. If the upload is refused because of it, set `strict_min_version` to `140.0` (and `142.0` in `gecko_android`) in `tools/build.js`, rebuild, and say in the listing that Firefox 140 or newer is needed.

## 2. Notes to reviewer

```text
No account is needed to install. The extension has no background script, requests only the "storage" permission plus access to x.com and twitter.com (content scripts), makes no network requests of its own and loads no remote code. data_collection_permissions: required ["none"]. strict_min_version is 128 because MAIN-world content scripts need 128; Firefox 127 and older reject the key and 128 to 139 ignore it, which is harmless because nothing is collected.

What it does: on x.com / twitter.com it keeps the Home timeline from loading its next page on its own. hook.js is a content script that runs in the page's own world ("world": "MAIN", Firefox 128+), because only there can it wrap the page's XMLHttpRequest and fetch. It recognises one kind of request - the GraphQL "HomeTimeline" / "HomeLatestTimeline" page request that carries a bottom paging cursor - and parks it until the user presses the extension's button, then lets it go unchanged. Every other request passes through untouched; on any error or surprise it falls back to the original function. hook.js does nothing if it finds itself in the extension's world (chrome.runtime.id exists). content.js + i18n.js + content.css run in the extension's world and draw the button, a status chip and a settings sheet (DOM built with createElement/textContent, no innerHTML). The two scripts talk with window.postMessage (accepted only from the same window and a private tag).

Source and build: the attached source package builds the uploaded file with `node tools/build.js --only firefox` (Node 18 or newer; no npm packages, no network). BUILD.md in the package lists the few steps the build performs (remove the TEST-HOOKS blocks from content.js and hook.js, generate i18n.js from locales/*.json, write manifest.json, zip in a fixed order with fixed timestamps). The output dist/ondemand-for-x-<version>-firefox.zip should contain exactly the same files with identical contents as the uploaded zip (unzip both and run `diff -r`; the zip bytes themselves can differ when a different Node.js/zlib version compresses them). The SHA-256 of the released file is in SHA256SUMS.txt of the GitHub release.

How to test: log in to any X account, open https://x.com/home, scroll to the end of the first batch: a panel "Batch finished / Load a new batch" appears and X is not asked for more posts until the button is pressed. Without an X account the extension has nothing to act on and shows no interface. The behaviour can also be exercised against a simulated page: `npm install && npx playwright install chromium && npm test` (Chromium).
```

## 3. Listing (Basic information)

Add the English listing, then an Arabic one (*Edit product page → Describe → language selector*). Texts are in [listing.md](listing.md).

| Field | English | Arabic |
|---|---|---|
| Name | `name-en` | `name-ar` |
| Add-on URL (slug) | `ondemand-for-x` | |
| Summary (max 250) | `amo-summary-en` | `amo-summary-ar` |
| Description | `description-en` (Markdown subset allowed; the text works as plain text) | `description-ar` |
| Categories (up to 2) | **Social & Communication** (the closest; a second one only if it adds value) | same |
| Tags | `amo-tags` | |
| Default locale | English | |
| Icon | taken from the package (`icons/`); Mozilla's sizes: 32×32 and 64×64 | |
| Screenshots | `screenshots/1…5` (1280×800 is Mozilla's recommended size); captions from the table in `listing.md` | one set of images, captions per language |
| Support e-mail | your address (Mozilla: at least this) | |
| Support site | `https://github.com/renlesss/OnDemand-for-X/issues` | |
| Homepage | `https://github.com/renlesss/OnDemand-for-X` | |
| Licence | **MIT License** (choose it in the list) | |
| Privacy policy | paste the text of [PRIVACY.md](../PRIVACY.md) | |
| Experimental | leave it unticked (the smoke test described at the top has to pass before you submit) | |

Release notes of the first version: `release-notes-en` / `release-notes-ar`.

## 4. After approval

1. Put the AMO link into `README.md`, `README.ar.md` and the GitHub release notes.
2. Every update: raise the version everywhere (docs/RELEASING.md), upload the new zip **and** the new source zip through *Upload new version* on the add-on's page (so AMO recognises it as an update).
3. Never change the add-on id.
