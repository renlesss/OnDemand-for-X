#!/usr/bin/env node
'use strict';
/*
 * Draws the screenshots used by the READMEs and the store listings from the SIMULATED feed in test/
 * (made-up posts and people, no real accounts, no X logo). Run: node tools/screenshots.cjs
 *
 *   docs/img/*.png                README
 *   store/screenshots/*.png       1280x800 with a caption band, for the store listings
 *   store/assets/promo-*.png      the two optional promotional tiles of the Edge Add-ons listing (440x280, 1400x560)
 *   store/assets/social-preview-*.png   GitHub's social preview image (1280x640)
 */
const fs = require('fs');
const path = require('path');
const { chromium, CHROME, openHome, gotoEnd, sleep } = require('../test/run-tests.cjs');

const ROOT = path.resolve(__dirname, '..');
const IMG = path.join(ROOT, 'docs', 'img');
const STORE = path.join(ROOT, 'store', 'screenshots');
const ASSETS = path.join(ROOT, 'store', 'assets');

// one raw screenshot of the extension on the demo feed
async function raw(browser, opt, after) {
  const { ctx, page } = await openHome(browser, opt);
  try {
    await gotoEnd(page);
    if (after) await after(page);
    await sleep(400);
    return await page.screenshot();
  } finally { await ctx.close(); }
}

const b64 = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; width: 1280px; height: 800px; overflow: hidden; font-family: system-ui, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Arabic", sans-serif;
         background: linear-gradient(135deg, #2b45c8 0%, #3558e6 55%, #5b7bff 100%); color: #fff; }
  h1 { margin: 0 0 10px; font-size: 44px; line-height: 1.1; letter-spacing: -0.5px; }
  p { margin: 0; font-size: 22px; line-height: 1.4; opacity: .92; }
  .shot { border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.35); display: block; }
  .band { height: 120px; padding: 22px 48px 0; }
  .phones { display: flex; gap: 28px; align-items: flex-start; }
`;

// 1280x800: caption band on top, the screenshot (1280x680 viewport scaled to fit) below
async function withBand(browser, shot, head, sub, rtl) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><meta charset="utf-8"><style>${CSS}
    .wrap { position: absolute; left: 0; right: 0; top: 120px; bottom: 0; overflow: hidden; }
    .wrap img { width: 1280px; height: 680px; display: block; }
  </style><div class="band"><h1>${head}</h1><p>${sub}</p></div><div class="wrap"><img src="${b64(shot)}"></div>`);
  const out = await page.screenshot();
  await ctx.close();
  return out;
}

// 1280x800: the caption on the left, one or two phone screenshots on the right
async function withPhones(browser, shots, head, sub, rtl) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const imgs = shots.map((s) => `<img class="shot" src="${b64(s)}" style="height:704px">`).join('');
  await page.setContent(`<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><meta charset="utf-8"><style>${CSS}
    .row { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 64px; }
    .txt { width: 480px; }
    .txt h1 { font-size: 50px; }
    .phones { padding-top: 0; }
  </style><div class="row"><div class="txt"><h1>${head}</h1><p>${sub}</p></div><div class="phones">${imgs}</div></div>`);
  const out = await page.screenshot();
  await ctx.close();
  return out;
}

// promotional tiles: exact sizes the Edge Add-ons listing asks for
async function tile(browser, w, h, html) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}
    body { width: ${w}px; height: ${h}px; position: relative; }
    .abs { position: absolute; }
  </style>${html}`);
  const out = await page.screenshot();
  await ctx.close();
  return out;
}

const save = (dir, name, buf) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  console.log('wrote', path.relative(ROOT, path.join(dir, name)));
};

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-smooth-scrolling'] });
  const desk = (theme, extra = {}) => ({ viewport: { width: 1280, height: 680 }, query: `?demo=1&theme=${theme}`, ...extra });
  const phone = (theme, lang, rtl) => ({ mobile: true, viewport: { width: 412, height: 800 }, settings: { lang }, query: `?demo=1&theme=${theme}${rtl ? '&rtl=1' : ''}` });

  // README (plain screenshots)
  save(IMG, 'panel-desktop.png', await raw(browser, { viewport: { width: 1280, height: 800 }, query: '?demo=1&theme=light' }));
  save(IMG, 'panel-mobile.png', await raw(browser, phone('dark', 'ar', true)));

  // store (1280x800)
  save(STORE, '1-one-batch-at-a-time.png', await withBand(browser, await raw(browser, desk('light')),
    'One batch at a time', 'X sends a batch. The next one is requested only when you press the button.'));
  save(STORE, '2-nothing-hidden.png', await withBand(browser, await raw(browser, desk('dark')),
    'Nothing hidden, nothing blocked', 'No reloads and no error messages: the next page simply waits for you.'));
  save(STORE, '3-your-language.png', await withBand(browser, await raw(browser, desk('dark'), async (page) => {
    await page.click('#xod-gate-settings');
    await page.evaluate(() => window.__xod.set({ lang: 'ja' }));
    await sleep(200);
  }), 'In your language', '14 languages: العربية · English · 简体中文 · 日本語 · Русский · Español · Deutsch · Türkçe · …'));
  save(STORE, '4-made-for-phones.png', await withPhones(browser,
    [await raw(browser, phone('light', 'en', false)), await raw(browser, phone('dark', 'ar', true))],
    'Made for small screens too', 'The button sits above the bottom bar and the status chip stays out of the way.'));
  save(STORE, '5-diagnostics.png', await withBand(browser, await raw(browser, desk('dark'), async (page) => {
    await page.click('#xod-gate-settings');
    await page.evaluate(() => { document.getElementById('xod-diag-box').open = true; });
    await sleep(500);
  }), 'Built to step aside', 'If X changes, requests pass through untouched. A diagnostics text you can copy helps fix it.'));

  // promotional tiles (English; the icon, the name, one sentence and the real interface on a phone)
  const icon = b64(fs.readFileSync(path.join(ROOT, 'icons', 'icon128.png')));
  const phoneLight = b64(await raw(browser, phone('light', 'en', false)));
  const phoneDark = b64(await raw(browser, phone('dark', 'ar', true)));
  save(ASSETS, 'promo-small-440x280.png', await tile(browser, 440, 280, `
    <img class="abs" src="${icon}" style="left:34px;top:34px;width:84px;height:84px;border-radius:20px;box-shadow:0 8px 24px rgba(0,0,0,.3)">
    <div class="abs" style="left:34px;top:140px;width:372px">
      <div style="font-size:31px;font-weight:800;line-height:1.1;letter-spacing:-.3px">OnDemand for X (Twitter)</div>
      <div style="margin-top:12px;font-size:20px;line-height:1.35;opacity:.92">Your timeline, one batch at a time.</div>
    </div>`));
  save(ASSETS, 'promo-large-1400x560.png', await tile(browser, 1400, 560, `
    <img class="abs" src="${icon}" style="left:72px;top:72px;width:104px;height:104px;border-radius:24px;box-shadow:0 10px 30px rgba(0,0,0,.3)">
    <div class="abs" style="left:72px;top:210px;width:640px">
      <div style="font-size:60px;font-weight:800;line-height:1.05;letter-spacing:-.8px">OnDemand for X (Twitter)</div>
      <div style="margin-top:20px;font-size:30px;line-height:1.35;opacity:.95">Your timeline, one batch at a time, only when you press the button.</div>
    </div>
    <img class="abs shot" src="${phoneLight}" style="left:760px;top:-20px;width:309px;height:600px">
    <img class="abs shot" src="${phoneDark}" style="left:1088px;top:-20px;width:309px;height:600px">`));
  // GitHub "social preview" (2:1), also fine as a header image for posts
  save(ASSETS, 'social-preview-1280x640.png', await tile(browser, 1280, 640, `
    <img class="abs" src="${icon}" style="left:72px;top:96px;width:104px;height:104px;border-radius:24px;box-shadow:0 10px 30px rgba(0,0,0,.3)">
    <div class="abs" style="left:72px;top:240px;width:620px">
      <div style="font-size:58px;font-weight:800;line-height:1.05;letter-spacing:-.8px">OnDemand for X (Twitter)</div>
      <div style="margin-top:20px;font-size:28px;line-height:1.35;opacity:.95">Your timeline, one batch at a time, only when you press the button.</div>
    </div>
    <img class="abs shot" src="${phoneLight}" style="left:790px;top:-70px;width:371px;height:720px">`));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
