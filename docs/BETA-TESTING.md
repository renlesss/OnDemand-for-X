# Help us test on a real device

The automated tests use a simulated X. Only a real device can show that the extension and X's real website agree. Ten minutes of your time is a big help. You need an X account that is logged in; **nothing about your account is collected**.

## 0. Install

Follow *Install* in the [README](../README.md) for your browser. Make sure the extension is switched on and refresh `x.com/home`. You should see a small chip with a slider icon at the bottom-left of the feed, saying **active**.

## 1. The ten-minute test

| # | Do | You should see |
|---|---|---|
| 1 | Open `x.com/home` ("For you"). Wait for the first batch. | The chip says *active*. Posts appear normally. |
| 2 | Scroll to the end of the batch. | The panel **Batch finished — Load a new batch** appears above the bottom bar; the last post is not covered by it. The chip says *waiting for you* (or is replaced by the panel). |
| 3 | Wait two minutes. | **Nothing new arrives.** (The spinner under the last post is normal.) |
| 4 | Like a post, scroll up and down. | Everything works, the panel goes away when you scroll up and returns at the end. |
| 5 | Press **Load a new batch**. | One batch arrives (its size is X's choice and varies), then the panel returns at the new end. |
| 6 | Pull down to refresh (phone) / use the refresh of the page. | A fresh feed loads normally, no stuck panel. |
| 7 | Switch to **Following** and scroll to its end. | The panel appears for *Following*; pressing it loads Following posts. Switch back to *For you*: its panel works too. |
| 8 | Open a post, go back. | The feed is where you left it; the panel returns at the end if a page is waiting. |
| 9 | Settings (slider icon) → switch the extension **off**, scroll to the end. | X loads more by itself, like without the extension. Switch it **on** again. |

## 2. The long wait (the most valuable test)

This checks that X does not give up on a request that waits a long time.

1. Scroll to the end of a batch so the panel appears.
2. Leave the tab open for **30 to 60 minutes** (the screen may lock; keep the browser in memory if you can).
3. Come back and press **Load a new batch**.

Expected: the batch arrives. Please report what happens either way, including *"X showed an error"*, *"the page reloaded"*, or *"nothing happened"*.

## 3. Report

Open an [issue](../../../issues/new/choose) and choose **Test report**. Please include:

- browser and version, device and Android / OS version, extension version;
- which steps passed and which did not;
- the **Diagnostics** text: settings (slider icon) → *Diagnostics* → *Copy*, then paste it. It holds no posts, names or account data: counters, X's request type names, timings, short fragments of paging cursors, and your browser's user-agent. Please read it before you paste it if you want to be sure.

For the *long wait*, copy the Diagnostics **after** pressing the button; the log shows `HOLD … RELEASE … after 1800s … DONE ok=true status=200`.

## What is still unverified (so you know where to look)

- Real X on desktop Chrome / Edge / Brave.
- Firefox, desktop and Android (the package has never been run in Firefox).
- Very long waits: whether X still accepts a request that was parked for minutes or hours (some headers it sends may depend on the time the request was created). If the release fails, the chip says *load failed*, X's own **Retry** goes straight through, and the Diagnostics log shows it: that is exactly the report we need.
- A release that ends with a long silence: after 90 seconds without an answer the button is free again (the reply still lands if it comes later).
- The **Following** tab on a phone layout (the extension then cannot read which tab is selected and serves the newest waiting page).
- Other languages' layout in the real X (the texts were checked at 320–1280 px on the simulated page).
