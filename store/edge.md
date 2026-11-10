# Microsoft Edge Add-ons — field by field

Developer registration for Edge extensions is free (Microsoft: "There is no registration fee for submitting extensions to the Microsoft Edge program"). You need a personal Microsoft account (a GitHub account can be used to create one), and the **individual** account type is enough. Certification takes up to seven business days (Microsoft's figure). Portal: Partner Center, in the Microsoft Edge program.

Package to upload: `ondemand-for-x-<version>-chromium.zip` (from the GitHub release; check its SHA-256 against `SHA256SUMS.txt`).

The same package runs in Chrome, Brave and Lemur. Lemur and Chrome users who do not use Edge get it from the GitHub release (see the README).

## 1. Properties

| Field | Enter |
|---|---|
| Category | The closest to a social-feed tool (**Social**; if the list has no such entry, **Productivity**) |
| Privacy policy URL | `https://github.com/renlesss/OnDemand-for-X/blob/main/PRIVACY.md` — optional for an extension that collects nothing, but it is public and short, so give it |
| Website | the repository: `https://github.com/renlesss/OnDemand-for-X` (must be your own page, not the store page) |
| Support contact | `https://github.com/renlesss/OnDemand-for-X/issues` (or an e-mail address) |
| Mature content | no |

## 2. Privacy and compliance questions

**Single purpose**

```text
Gives the Home timeline of X (Twitter) an end: it holds the request for the next page of posts until the user presses a button in the extension.
```

**Permission justifications**

| Permission shown | Justification |
|---|---|
| `storage` | Saves two settings on the device, in `storage.local`: whether the extension is on, and the interface language. Nothing is synced or sent anywhere. |
| Access to x.com and twitter.com (content scripts) | The extension must run on X's own pages, because that is where the Home timeline's "next page" request has to be held and where the button is shown. It runs on no other site, has no background process and makes no network requests of its own. |

**Remote code:** No. Manifest V3; all code is in the package; no `eval`, no remote scripts (the build fails if they appear).

**Data usage:** the extension collects no user data in any category and transmits nothing off the device. It reads the paging parameters of the Home-timeline requests and replies in the page, in memory, to recognise the "next page" request; nothing is stored or sent. Certify: not sold or transferred to third parties, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.

## 3. Store listing (English; Edge shows one language for this package)

| Field | Enter | From |
|---|---|---|
| Name | `OnDemand for X (Twitter)` | the package (`manifest.json`) |
| Short description | the manifest description | the package |
| Description | English text, a blank line, `———`, a blank line, Arabic text (250–10,000 characters; plain text) | `listing.md` → *Description for Microsoft Edge* |
| Extension logo | `assets/logo-300.png` (300×300; 128×128 is the minimum) | `assets/` |
| Screenshots | `screenshots/1-…png` to `5-…png` (1280×800; at most 6) | `screenshots/` |
| Small promotional tile | `assets/promo-small-440x280.png` (optional) | `assets/` |
| Large promotional tile | `assets/promo-large-1400x560.png` (optional, PNG) | `assets/` |
| Video | none | |
| Search terms | the seven terms of `edge-search-terms` | `listing.md` |

Why one language: Edge lists extra languages only for packages that contain `_locales/` with `__MSG_…__` names. This extension keeps its texts in its own `locales/` files on purpose: the build that was confirmed on a real Lemur phone kept its texts inside `content.js`, not in Chrome's `_locales/`, and this release avoids that untested difference. Adding `_locales/` later is possible (and would give Edge a separate Arabic listing), but it has to be tested on Lemur first.

## 4. Notes for certification (entered when you press Publish)

```text
No account or test credentials are needed to install the extension.

What to look at: the extension works on x.com and twitter.com only. With any X account logged in, open https://x.com/home, let the first batch of posts load and scroll to its end. A panel "Batch finished / Load a new batch" appears and X is not asked for more posts until the button is pressed; a spinner under the last post is normal (X is waiting for an answer that has not been requested yet). Pressing the button loads one batch and the panel returns at its end. Without an X account (X shows a login wall) the extension has nothing to act on and shows no interface.

The extension has no background process, requests only the storage permission, makes no network requests of its own and loads no remote code. All source code is public: https://github.com/renlesss/OnDemand-for-X (MIT). Without an X account its behaviour can be exercised against a simulated X page: `npm install && npx playwright install chromium && npm test` (the full suite, including this package loaded as a real extension under a strict page policy).

Status chip: "active", "waiting for you", "loading…", "off"; if X changes its site the chip says "not working" and X keeps loading as if the extension were absent. Settings (the slider icon) → Diagnostics shows the text users send with bug reports; it holds no posts or account details (it does list the browser version and window size).
```

## 5. After approval

1. Put the store link into the README (*Install*), `README.ar.md` and the GitHub release notes.
2. Updates: upload the new package (the version number must be higher), say what changed, and keep `PRIVACY.md` and the permission texts in step with the code.
