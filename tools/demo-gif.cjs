#!/usr/bin/env node
'use strict';
/*
 * Records the short silent demo animations of the extension (docs/img/demo-en.gif, docs/img/demo-ar.gif) from the
 * SIMULATED feed in test/ (made-up posts and people, no real accounts, no X logo).
 *
 *   node tools/demo-gif.cjs          (needs ffmpeg and Playwright's Chromium, like the tests)
 *
 * The story: scroll the batch → end of the batch (X is asked for nothing more) → press the button → one batch
 * arrives → it stops again. The caption pill and the tap ring are drawn by this script on top of the page;
 * they are not part of the extension.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium, CHROME, openHome, sleep } = require('../test/run-tests.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'img');
const FPS = 10;
const WIDTH = 340;                           // pixels of the finished animation

const LANGS = {
  en: {
    rtl: false, theme: 'light',
    cap: { scroll: 'Scroll your batch', end: 'End of batch. Nothing more is asked.', press: 'You press the button', arrive: 'One new batch arrives', again: '…and it stops again.' },
  },
  ar: {
    rtl: true, theme: 'dark',
    cap: { scroll: 'تصفّح دفعتك', end: 'خلصت الدفعة. ما نطلب شي زيادة.', press: 'تضغط الزر', arrive: 'توصلك دفعة وحدة', again: '…وتوقف مرة ثانية.' },
  },
};

async function overlay(page) {
  await page.evaluate(() => {
    const cap = document.createElement('div');
    cap.id = 'demo-caption';
    cap.style.cssText = 'position:fixed;top:7px;left:50%;transform:translateX(-50%);max-width:94%;white-space:nowrap;z-index:2147483646;background:rgba(10,10,10,.82);' +
      'color:#fff;font:700 14px/1.35 system-ui,"Segoe UI",Roboto,"Noto Sans","Noto Sans Arabic",sans-serif;padding:9px 16px;border-radius:999px;text-align:center;pointer-events:none';
    const tap = document.createElement('div');
    tap.id = 'demo-tap';
    tap.style.cssText = 'position:fixed;z-index:2147483647;width:60px;height:60px;margin:-30px 0 0 -30px;border-radius:50%;border:3px solid rgba(255,255,255,.95);' +
      'background:rgba(255,255,255,.28);box-shadow:0 0 0 2px rgba(0,0,0,.25);display:none;pointer-events:none';
    document.body.append(cap, tap);
  });
}
const caption = (page, text) => page.evaluate((t) => { document.getElementById('demo-caption').textContent = t; }, text);
const tapAt = (page, x, y) => page.evaluate(([px, py]) => { const t = document.getElementById('demo-tap'); t.style.left = px + 'px'; t.style.top = py + 'px'; t.style.display = 'block'; }, [x, y]);
const tapOff = (page) => page.evaluate(() => { document.getElementById('demo-tap').style.display = 'none'; });
const panelOn = (page) => page.evaluate(() => {
  const g = document.getElementById('xod-gate');
  return !!g && g.classList.contains('xod-on') && getComputedStyle(g).visibility === 'visible';
});
async function waitPanel(page, on, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await panelOn(page)) === on) return true; await sleep(50); }
  return false;
}

async function record(browser, code) {
  const L = LANGS[code];
  const { ctx, page } = await openHome(browser, {
    mobile: true, viewport: { width: 412, height: 800 }, settings: { lang: code },
    query: `?demo=1&theme=${L.theme}${L.rtl ? '&rtl=1' : ''}`,
  });
  const frames = [];
  try {
    await overlay(page);
    const snap = async (n = 1) => { const buf = await page.screenshot(); for (let i = 0; i < n; i++) frames.push(buf); };
    const scrollTo = async (y, wait = 70) => { await page.evaluate((v) => window.scrollTo(0, v), y); await sleep(wait); };
    const maxY = () => page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);

    // 1. the batch, from the top
    await caption(page, L.cap.scroll);
    await sleep(300);
    await snap(8);
    let end = await maxY();
    const mid = Math.max(end - 1000, 200);
    for (let i = 1; i <= 10; i++) { const k = i / 10; await scrollTo(Math.round(mid * (1 - (1 - k) * (1 - k))), 60); await snap(1); }
    // 2. the last stretch, then the end of the batch
    end = await maxY();
    for (let i = 1; i <= 12; i++) { await scrollTo(Math.round(mid + ((end - mid) * i) / 12), 60); await snap(1); }
    await scrollTo(await maxY(), 200);
    await caption(page, L.cap.end);
    if (!await waitPanel(page, true)) throw new Error('the panel did not appear at the end of the batch');
    await sleep(250);
    await snap(22);

    // 3. the press
    await caption(page, L.cap.press);
    const r = await page.evaluate(() => { const b = document.getElementById('xod-more').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await tapAt(page, r.x, r.y);
    await snap(5);
    await tapOff(page);
    await page.click('#xod-more');

    // 4. one batch arrives
    await caption(page, L.cap.arrive);
    for (let i = 0; i < 6; i++) { await sleep(80); await snap(1); }
    await waitPanel(page, false, 5000);
    const here = await page.evaluate(() => window.scrollY);
    for (let i = 1; i <= 8; i++) { await scrollTo(here + i * 70, 60); await snap(1); }
    await snap(6);

    // 5. and it stops again
    await page.evaluate(() => window.__mock.scrollToEnd());
    await sleep(400);
    await caption(page, L.cap.again);
    if (!await waitPanel(page, true)) throw new Error('the panel did not come back at the end of the second batch');
    await sleep(250);
    await snap(26);
  } finally { await ctx.close(); }
  return frames;
}

function makeGif(frames, file) {
  const dir = fs.mkdtempSync(path.join(process.env.XOD_TMP || os.tmpdir(), 'xod-demo-'));
  try {
    frames.forEach((buf, i) => fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.png`), buf));
    const vf = `scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%04d.png'), '-vf', vf, '-loop', '0', file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-smooth-scrolling'] });
  try {
    for (const code of Object.keys(LANGS)) {
      const frames = await record(browser, code);
      const file = path.join(OUT, `demo-${code}.gif`);
      makeGif(frames, file);
      console.log('wrote', path.relative(ROOT, file), `${frames.length} frames, ${Math.round(fs.statSync(file).size / 1024)} KB`);
    }
  } finally { await browser.close(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
