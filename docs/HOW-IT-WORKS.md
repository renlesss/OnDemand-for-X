# How OnDemand for X works

This page is for people who want to check the claims in the README, review the code, or fix something when X changes.

## The idea in one picture

```
 you scroll to the end of the batch
          │
          ▼
 X's page asks for the NEXT page ──►  hook.js (inside X's page) recognises that exact request
                                              │
                          parks it: the request is NOT sent, X is NOT contacted
                                              │
                      content.js shows "Batch finished — Load a new batch"
                                              │
                          you press the button ──► hook.js lets the parked request go, unchanged
                                              │
                                  X answers, the posts arrive, one batch
```

Nothing is hidden, nothing is blocked, nothing is rewritten. The request is only **delayed** until you ask for it.

## Files

| File | Runs where | Job |
|---|---|---|
| `src/hook.js` | in **X's own page** (the page's JavaScript world) | wraps `XMLHttpRequest` and `fetch`; recognises the Home timeline's "next page" request; parks and releases it |
| `src/content.js` | the extension's isolated world | the chip, the panel and its button, the settings sheet, the diagnostics; stores the two settings; talks to `hook.js` with `window.postMessage` |
| `src/content.css` | the page (injected by the extension) | styles; every id and class starts with `xod-` |
| `locales/*.json` → `i18n.js` | the extension's isolated world | the interface texts (generated at build time) |
| `tools/build.js` | your machine | builds and checks the packages in `dist/` |

`hook.js` has to live in the page's world because only there can it see X's own network calls. The manifest declares it as a content script with `"world": "MAIN"` (Chromium 111+, Firefox 128+): it then runs before any script of X, and no page policy (CSP) can block it. A browser that ignores that setting would run the file in the extension's world, where it could only wrap private copies of those APIs; so `hook.js` **does nothing** when it finds the extension APIs (`chrome.runtime.id`) around it, and `content.js` adds the same file to the page as a `<script>` tag when no hook answered within about half a second. The diagnostics say which way it came in (`via manifest` or `via script tag`).

## What counts as "the next page"

`hook.js` looks only at X's GraphQL operations **`HomeTimeline`** (For you) and **`HomeLatestTimeline`** (Following). For each such request it reads the GraphQL variables (in the URL for GET, in the JSON body for POST) and decides:

| Situation | Decision |
|---|---|
| extension switched off | pass |
| variables cannot be read | pass |
| no `cursor` (first load, refresh) | pass |
| cursor is one X gave as a **Top** cursor ("N new posts") or any other kind | pass |
| unknown cursor with `requestContext: "ptr"` (pull-to-refresh) | pass |
| X's own **retry** within 10 minutes after a failed release | pass (once) |
| **otherwise: a cursor that X gave as the Bottom cursor, or one we have not seen** | **hold** |

The cursors are learned from the **replies** of the same Home-timeline requests: each reply is scanned in memory for objects that have `cursorType` and `value`, and nothing else is kept. They live in memory only.

**The rule is "when in doubt, send it", with one deliberate exception:** a cursor the hook has never seen is held (`why: unknown` in the diagnostics). The hook may have started after X's first reply (a browser that adds it late), or X may be showing a timeline it restored from its own cache, whose next-page cursor was learned in an earlier visit. For the reader's purpose, holding is the safe side of that doubt, and it costs at most one press: the button releases it, and so does every valve in the next section. (Worst case: a request for newer posts that carries a cursor from an earlier visit waits for one press. A test covers the unknown-cursor case.)

## Releasing

The button sends `release` (with the timeline on screen, if it can be read, and a sequence number). The hook releases the **newest** waiting cursor of that timeline, forgets older different ones (a refresh replaced that feed; X will not ask for them again), and answers with the sequence number it handled so the interface knows the press arrived. A second press while one is loading does nothing.

## Fail-open rules

Anything unexpected must leave X working as if the extension were absent:

- every wrapped function falls back to the original on any error, and an error inside the hook is never rethrown into X's code. What X *can* notice: a `fetch` that X aborts itself (or that a refresh made obsolete) is rejected with an `AbortError`, the way the browser would reject it, and an aborted or obsolete XHR simply never gets an answer, as if it had never been sent;
- unreadable, unknown or oddly shaped requests pass through;
- switching the extension off releases everything at once;
- if X cancels a parked request itself (`abort`, or re-opening the same XHR), it is forgotten, never sent;
- if the interface stops answering (the extension was updated or switched off while a request was parked), the hook sends a `ping` every 3 seconds while anything is parked, and the interface answers at once. No `pong` for 15 seconds means nobody can press the button: everything parked is released and nothing is parked again until the interface speaks again. A hook that has never heard from an interface parks nothing at all;
- a released request that has not ended after 90 seconds, or whose XHR object X re-opens, stops blocking the button (it counts as finished without an answer);
- if the hook never answers, the chip says *not working* after 4 seconds (shown on `/home`, once the page structure exists) and X is unaffected (nothing was parked);
- if the page structure the interface attaches to (`<main>`) is missing for 6 seconds on `/home` while something is parked, the hook is told to **let everything through** until the structure returns;
- the interface hides itself while an X dialog is open and outside `/home`; the parked request stays parked meanwhile.

## Which timeline is on screen?

The panel must serve the tab you are looking at. `content.js` reads the tab strip (`role="tablist"` / `role="tab"`, `aria-selected`): first tab → `HomeTimeline`, second → `HomeLatestTimeline`, any further tab (a pinned list) → "other": no panel, nothing is parked for it. If the strip cannot be found (some phone layouts), **any** parked request counts and the button serves the newest one. If X parks a request for the *other* timeline while this tab is selected (the strip's order is not what we assume), the interface trusts what X did: a request parked while tab N was selected belongs to tab N.

## Messages between the two scripts

`window.postMessage({ __xod: 'xod-1', from: 'ui' | 'hook', type, … }, location.origin)`, accepted only when `event.source === window`.

| From | Type | Meaning |
|---|---|---|
| ui | `hello` | "are you there?" (answered with `ready`) |
| ui | `config` | `{ enabled }` — off releases everything |
| ui | `release` | `{ op, seq }` |
| ui | `getlog` | asks for the diagnostics snapshot |
| ui | `pong` | the answer to a `ping`, sent at once from the message handler (not from a timer) |
| hook | `ready` | `{ v, via, late }` |
| hook | `state` | `{ held[], inflight, ack, gone, stats }` after every change (`gone`: the hook let everything through because it heard nothing from the interface) |
| hook | `ping` | while something is parked: "can anybody still press the button?" (every 3 s) |
| hook | `done` | a released request finished (`ok`, `status`, `ms`) |
| hook | `log` | the diagnostics snapshot |

Any script on the page can post such messages. They can only change the extension's own interface state or release a request X was about to make anyway; see [SECURITY.md](../SECURITY.md).

## Tests

`node test/run-tests.cjs` runs Chromium against a **simulated X** (`test/mock-x.html`: virtualised list, ads, modules, tabs, a fake GraphQL server that records what *really* reaches it). A request that was parked never appears in that log — that is how "X was not contacted" is proved rather than assumed. The suite covers the core promise, refresh and retry flows, both timelines, XHR and `fetch`, other extensions wrapping the same APIs, the page layouts (window or inner scroller, with and without virtualisation, RTL), touch and wheel scrolling on phone and desktop sizes, all languages and their fit at 320 px, and the **built packages** loaded as real extensions under a strict page policy.

What the tests **cannot** show: that X's real website still looks the way the simulation assumes. That is what [BETA-TESTING.md](BETA-TESTING.md) and the diagnostics are for.

## When X changes something

1. Ask the reporter for the **Diagnostics** text (settings → *Diagnostics* → *Copy*).
2. Look at `hook:` (how it arrived), `requests seen=…`, `graphql operations seen:` (are the operation names still `HomeTimeline` / `HomeLatestTimeline`?), `timeline on screen:` and `page structure:` (are `main`, the tab strip and the posts found?), then the request log lines (`pass:first`, `HOLD`, `RELEASE`, `DONE`).
3. Add the new shape to `test/mock-x.html` (it has switches for most layout variants) and make a failing test first.
4. Fix `src/`, run `npm run check`.
