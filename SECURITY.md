# Security policy

## Reporting a vulnerability

Please report security problems **privately**: on GitHub open the *Security* tab of this repository and choose **Report a vulnerability**. If that is not available, open an [issue](../../issues) that says only that you have a security report (no details) and a maintainer will arrange a private channel.

You will get an answer within a few days. Please give us a reasonable time to fix a problem before you publish it.

## Supported versions

Only the latest release is supported.

## What the extension can and cannot do

- It runs on `x.com` and `twitter.com` only, requests only the `storage` permission, has no background process and makes no network requests of its own.
- Part of it (`hook.js`) runs inside X's own page so that it can hold one kind of request. That file talks to the extension's other script only through `window.postMessage`. **Any script on the page can post such messages**, so the extension never trusts them with anything but its own state. The worst a forged message can do is switch the extension off for that page (a `config` message), release a request that X was about to make anyway, make the extension's button appear or disappear, or ask the hook to post its diagnostic log (`getlog`; the log holds nothing that a script on the page could not already see for itself). A damaged message is ignored and cannot break the interface or the diagnostics (there is a test for this).
- A website can, in principle, notice that its network functions have been wrapped by a script (a `window.__xodHook` marker exists in the page, the wrapped functions are not native code, and with Chromium browsers a page can probe for the web-accessible `hook.js` of an extension it knows the ID of). Many extensions behave this way. OnDemand does not try to hide itself.
- The package is built from the sources in this repository by `node tools/build.js`; the same sources and the same Node.js version give the same package (compare the files inside the zips, not the zip bytes, when you use a different Node.js version), and every release lists the SHA-256 of its files.

## Out of scope

Problems in X, in your browser, or in other extensions; and anything that needs a modified copy of the extension.
