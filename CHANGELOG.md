# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [0.9.1] — 2026-11-07

First public beta. Changes made after an independent review of 0.9.0 (the review build, never published). Eight new automated tests cover the safety items.

### Safety (fail-open)
- If the extension's interface stops answering while a request is parked (the extension was updated or switched off with the page open), the hook releases that request after about 15 seconds and parks nothing more until the interface speaks again. Before, it stayed parked until the page was reloaded. A hook that has never heard from an interface parks nothing at all.
- A released request that never ends (stuck connection, or X re-opens the `XMLHttpRequest` object) no longer blocks the button for good: 90 seconds at most, and a re-open ends it at once.
- If the tab strip's order is not what the extension assumes, a parked request still gets its panel and button (it belongs to the tab that was selected when X parked it).
- Forged or damaged messages from the page can no longer break the interface or the diagnostics.
- An `XMLHttpRequest` object that X re-uses no longer collects a new set of listeners for every request.
- The interface does no work in a background tab.

### Wording and documents
- Removed claims the tests do not support: "no errors", "usually 20–40 posts", the Lemur install steps, "sends nothing extra", "byte-identical" zips.
- The privacy policy now says exactly what is read (timeline replies are scanned in memory for paging cursors; only the cursors and counters are kept) and what the diagnostics hold. The diagnostics hint no longer says "no personal data" in any language: it names the browser version and window size. The diagnostics' page line shows only `/home` or "(not the home page)".
- The documentation explains the one deliberate exception to "when in doubt, send it": a cursor the hook has never seen is held.
- Firefox notes: `data_collection_permissions` and the minimum version, and a smoke test before submitting.
- Translation fixes: Arabic, Turkish, Japanese, Indonesian, French.

## [0.9.0] — 2026-10-30

The build that went to the independent review. Never published; superseded by 0.9.1.

### What it is
- Holds back X's request for the *next page* of the Home timeline (both **For you** and **Following**) until you press **Load a new batch**. Nothing is hidden. Designed so that nothing reloads and X shows no error (confirmed on a simulated X).
- Chip showing the state; "batch finished" panel with the button; settings sheet; diagnostics you can copy.

### New in this release (compared with the private v2 it grew out of)
- The hook is now declared in the manifest as a page-world content script (Chromium and Firefox 128+), so no page policy can block it and it is in place before X's first script. Browsers that ignore that setting get the same file as a `<script>` tag (verified in Chromium with the setting removed).
- Fail-open safety valve: if the page structure the interface attaches to is missing for 6 seconds while a request is parked, the request is released and parking pauses until the structure returns.
- Tab detection: pinned lists (a third tab) are left alone; unfamiliar markup and phone layouts without a readable tab strip fall back to "any parked request counts".
- Diagnostics now say how the hook arrived and describe the page structure (counts only).
- Interface in 14 languages with a picker: Arabic, German, English, Spanish, French, Indonesian, Japanese, Korean, Portuguese (Brazil), Russian, Thai, Turkish, Simplified and Traditional Chinese. *Auto* follows the language X is shown in, then the browser's (`zh-Hant`, `zh-HK` and `zh-TW` get Traditional Chinese; other `zh` Simplified; `pt-PT` gets the Brazilian texts; the old code `in` is read as Indonesian).
- Packages for Chromium browsers (Chrome, Edge, Brave, Lemur …) and Firefox 128+ (desktop and Android), plus a source package; deterministic build with a manifest and forbidden-API check.

### Known limits
- Not yet confirmed on real X in every browser: see the status table in the README.
- Every language except English and Arabic was drafted with AI assistance and is waiting for a native-speaker review.
