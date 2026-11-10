# Store listings

Texts and pictures for the two stores that need **no paid developer account**:

| Store | Cost | Guide | Package |
|---|---|---|---|
| Microsoft Edge Add-ons | free to register ("There is no registration fee…", Microsoft) | [edge.md](edge.md) | `…-chromium.zip` |
| Firefox Add-ons (AMO) | no fee | [firefox.md](firefox.md) | `…-firefox.zip` + `…-source.zip` |

The Chrome Web Store is **not** used: it needs a paid developer registration. Chrome, Brave and Lemur users install from the GitHub release (see the README).

## What is here

| Path | What |
|---|---|
| `listing.md` | every text, English and Arabic; `npm run check:store` checks the limits |
| `edge.md`, `firefox.md` | the forms, field by field, including the permission justifications and the reviewer notes |
| `assets/logo-300.png` | Edge logo (300×300) |
| `assets/promo-small-440x280.png`, `assets/promo-large-1400x560.png` | Edge's two optional promotional tiles |
| `screenshots/1…5-*.png` | 1280×800 screenshots with a caption band, for both stores |

Everything in `assets/` and `screenshots/` is generated: `python3 tools/make_icons.py icons store/assets` and `node tools/screenshots.cjs`. They show a **simulated** demo feed (invented posts and people, no real accounts, no X logo), and the first screenshot's caption in `listing.md` says so.

## What the stores ask for (checked on 2026-10-31)

| Item | Edge Add-ons | Firefox (AMO) |
|---|---|---|
| Name | from the package | per language |
| Short text | manifest `description` (we keep it ≤132 characters) | *Summary*, at most 250 characters |
| Long text | 250–10,000 characters, per language | no hard limit; Markdown subset |
| Logo / icon | logo 300×300 recommended (128×128 minimum) | 32×32 and 64×64 (from the package) |
| Screenshots | up to 6, exactly 640×480 or 1280×800 | recommended 1280×800 (ratio 1.6:1) |
| Promotional images | optional: 440×280 and 1400×560 (PNG) | none |
| Privacy | single purpose, a justification per permission, remote-code and data-usage statements; policy URL if data is collected | `data_collection_permissions` in the manifest (done: `none`); policy text if personal data is used |
| Source code | not asked | **asked** when the build changes the files (it does): upload the source zip with build instructions |
| Review | up to 7 business days | varies |

Sources: Microsoft Learn *Publish an extension to the Microsoft Edge Add-ons website*; Mozilla Extension Workshop *Submitting an add-on*, *Create an appealing listing* and *Source code submission*.

## Before you submit

1. **Real-device test passed** and the version raised to the one you want to publish (see `docs/RELEASING.md`). A store review takes days, and a rejected or buggy first version costs trust.
2. **GitHub repository** (the stores want a support/homepage link and the privacy policy URL): the links in `edge.md` and `firefox.md` already point to `renlesss/OnDemand-for-X`. Before the first store submission also set `homepage` in `package.json` (the build then writes `homepage_url` into the manifest). The pre-releases leave it out on purpose, so that they stay identical to the packages that were tested.
3. **Support address**: Mozilla wants at least an e-mail address; Edge accepts a support page or an e-mail address.
4. **Publisher name**: both stores show who published the extension. Decide it before you register (it is hard to change later).
5. **Firefox smoke test** (desktop, `about:debugging`) — see `firefox.md`.

## Not done on purpose

- No `_locales/` folder, so Edge shows one (bilingual) listing. See the reason in `edge.md`.
- No Chrome Web Store listing.
- No claims of "first", "best" or numbers of users.
