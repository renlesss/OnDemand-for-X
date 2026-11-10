# Privacy policy — OnDemand for X (Twitter)

*Applies to version 0.9.1 and later. Last updated 2026-11-07 (wording made more exact; the behaviour did not change).*

**In one sentence: the extension collects nothing, sends nothing anywhere, and has no server, no account and no analytics.**

## What it does on your device

- It runs only on pages of `x.com` and `twitter.com`.
- To recognise the request X makes for "the next page" of the Home timeline, it looks at the **address and parameters of the Home-timeline requests that your own browser makes**, and it **scans the Home-timeline replies, in memory, to find the paging cursors** in them. Because the cursors sit inside the reply, the whole reply passes through that scan; **only the cursors and a few counters are kept**, in the memory of that one tab. They are forgotten when the tab is closed and are never written to disk or sent anywhere.
- It does **not** store, copy or transmit your posts, messages, followers, account details, cookies or credentials. Apart from the scan of the Home-timeline replies described above, it does not read them either. The interface only measures the layout of the page (where the list of posts ends, which timeline tab is selected) to place its button.
- It makes **no network requests of its own**. The only request it ever influences is one that your browser was already about to send to X; it holds that request until you press the button, then lets it go unchanged.

## What is stored

Two settings, in the browser's extension storage on your device (`storage.local`, not synced, not sent anywhere):

| Setting | Values |
|---|---|
| on / off | whether the extension is active |
| language | `auto` or one of the supported interface languages |

Nothing else is stored.

## Diagnostics

The settings sheet has a *Diagnostics* box. It builds a short text on demand: the extension's version, counters, the names of X's request types, timings, the first few characters and the length of paging cursors (opaque tokens), a summary of the page's structure (how many elements of some kinds there are, which tab is selected, whether the page is the Home page), the window size, whether the screen is a touch screen, the interface language, and your browser's user-agent string (which names your browser and operating system versions). **It is only copied to the clipboard if you press Copy, and it is only shared if you paste it somewhere yourself.** It contains no post text and no names or account details, but read it before you share it.

## Permissions

| Permission | Why |
|---|---|
| `storage` | to keep the two settings above |
| access to `x.com` and `twitter.com` (content scripts) | the extension has to run on X's pages to hold the next-page request and to show its button |

No other permissions are requested. There is no background process.

## Third parties, advertising, remote code

None. No analytics, no advertising, no third-party services, and no code is downloaded: everything that runs is in the package you installed (and the source is public).

## Changes and contact

Changes to this policy are made in this file and listed in the [changelog](CHANGELOG.md). Questions: open an [issue](../../issues).

*OnDemand for X is an independent project. It is not affiliated with, endorsed by or sponsored by X Corp. "X" and "Twitter" are trademarks of their owners and are used here only to say which website the extension works with.*
