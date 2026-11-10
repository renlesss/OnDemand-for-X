/*
 * End-to-end tests for OnDemand for X.
 *
 * A mock of X's home timeline (virtualised list, ads, "who to follow" modules, reposts,
 * For-you / Following tabs) talks to a fake X server through REAL XMLHttpRequest / fetch
 * calls, shaped like X's GraphQL timeline endpoints (cursors, Top / Bottom). The fake server
 * logs every request that really reaches it, so a test can prove that a parked request never
 * left the browser.
 *
 *   node tools/build.js                 (the last tests load the PACKAGED builds from dist/)
 *   node test/run-tests.cjs             run everything
 *   node test/run-tests.cjs parked      run tests whose name contains "parked"
 *
 * Environment (all optional):
 *   XOD_PLAYWRIGHT   path of the playwright module     XOD_CHROME       path of a Chromium/Chrome binary
 *   XOD_SRC          folder with content.js, hook.js…  XOD_EXT_DIR      unpacked extension for the packaged test
 *   XOD_CHROME_ARGS  extra Chromium flags
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadPlaywright() {
  const tries = [process.env.XOD_PLAYWRIGHT, 'playwright', '/opt/npm-tools/node_modules/playwright'].filter(Boolean);
  for (const t of tries) {
    try { return require(t); } catch (e) { /* try the next one */ }
  }
  throw new Error('Playwright was not found: run `npm install` or set XOD_PLAYWRIGHT=/path/to/playwright');
}
const { chromium } = loadPlaywright();
const FeedGen = require('./feed-gen.js');

function findChrome() {
  if (process.env.XOD_CHROME) return process.env.XOD_CHROME;
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* fall through */ }
  const guess = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  return fs.existsSync(guess) ? guess : undefined;
}

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.XOD_SRC || path.join(ROOT, 'src');
const CHROME = findChrome();
const CSS = fs.readFileSync(path.join(SRC, 'content.css'), 'utf8');
const JS = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
const HOOK = fs.readFileSync(path.join(SRC, 'hook.js'), 'utf8');
const I18N = require('../tools/lib/i18n.js');
const LOCALES = I18N.loadLocales(process.env.XOD_LOCALES || path.join(ROOT, 'locales'));
const I18N_JS = I18N.source(LOCALES);             // what the build writes to i18n.js, loaded before content.js
const FEEDGEN = fs.readFileSync(path.join(__dirname, 'feed-gen.js'), 'utf8');
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-x.html'), 'utf8').replace('/*FEEDGEN*/', () => FEEDGEN);
const FILTER = process.argv[2] || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

/* ───────────────────────────── tiny test kit ───────────────────────────── */

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n        expected: ${b}\n        actual:   ${a}`);
}
function noErrors(errors) {
  assert(!errors.length, `page errors:\n        ${errors.join('\n        ')}`);
}
async function test(name, fn) {
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

/* ───────────────────────────── the fake X server ───────────────────────────── */

function makeServer(opt = {}) {
  return {
    log: [],                                            // every timeline request that really reached the server
    epoch: { HomeTimeline: 0, HomeLatestTimeline: 100 },
    latency: opt.latency === undefined ? 40 : opt.latency,
    failNext: 0,                                        // answer the next N timeline requests with HTTP 500
  };
}

async function handleGraphql(server, route) {
  const req = route.request();
  const url = new URL(req.url());
  const m = /\/graphql\/[^/]+\/([A-Za-z]+)$/.exec(url.pathname);
  const op = m ? m[1] : '';
  let variables = null;
  try {
    if (req.method() === 'GET') variables = JSON.parse(url.searchParams.get('variables'));
    else variables = JSON.parse(req.postData() || 'null').variables;
  } catch (e) { variables = null; }
  const rec = {
    op, method: req.method(), cursor: (variables && variables.cursor) || null,
    ctx: variables && variables.requestContext, count: variables && variables.count, t: Date.now(), status: 0,
  };
  server.log.push(rec);
  await sleep(server.latency);
  // a page may have given up on the request meanwhile (an aborted XHR, a closed page): that is not an error of the server
  const reply = async (o) => { try { await route.fulfill(o); } catch (e) { /* nobody is waiting any more */ } };

  if (op !== 'HomeTimeline' && op !== 'HomeLatestTimeline') {
    rec.status = 200;
    return reply({ status: 200, contentType: 'application/json', body: '{"data":{}}' });
  }
  if (server.failNext > 0) {
    server.failNext--;
    rec.status = 500;
    return reply({ status: 500, contentType: 'application/json', body: '{"errors":[{"message":"boom"}]}' });
  }
  let epoch;
  if (!rec.cursor) { server.epoch[op] += 1; epoch = server.epoch[op]; }
  const r = FeedGen.timeline({ op, cursor: rec.cursor, count: variables && variables.count, epoch });
  rec.status = r.status;
  return reply({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.json) });
}

function routeMock(ctx, server, opt = {}) {
  return ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://x.com' && url.pathname === '/home') {
      const headers = opt.csp ? { 'content-security-policy': opt.csp } : {};
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers, body: MOCK });
    }
    if (url.origin === 'https://x.com' && url.pathname.startsWith('/i/api/graphql/')) return handleGraphql(server, route);
    if (url.origin === 'https://x.com') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>x</title>' });
    }
    if (url.protocol === 'chrome-extension:') return route.continue();      // the extension's own files (hook.js)
    return route.abort();
  });
}

const cursorReqs = (server, op) => server.log.filter((r) => r.cursor && (!op || r.op === op));

/* ───────────────────────────── page plumbing ───────────────────────────── */

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

const cssInit = (css) => {
  const add = () => {
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.documentElement) add();
  else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
};

// stands for another extension that also wraps XMLHttpRequest and fetch
const foreignWrap = (who) => {
  window.__foreign = window.__foreign || [];
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () { window.__foreign.push(`${who}:send`); return send.apply(this, arguments); };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () { window.__foreign.push(`${who}:open`); return open.apply(this, arguments); };
  const f = window.fetch;
  window.fetch = function () { window.__foreign.push(`${who}:fetch`); return f.apply(this, arguments); };
};

/*
 * opt: mobile, query, settings, server, testOpts
 *      control      no extension at all (the harness must be able to see deliveries)
 *      noHook       the extension without its page hook
 *      noUi         the page hook alone: the content script (the interface) never runs
 *      extWorldHook the hook file runs where `chrome.runtime.id` exists (a browser that ignores "world": "MAIN")
 *      foreign      two other scripts wrap XMLHttpRequest / fetch, one installed before the hook and one after it
 *      locale       the browser's language (default en-US)
 *      viewport     { width, height } instead of the default window / phone size
 *      hookLate     the hook is installed after X already made its first request
 *      lateContent  the content script is installed after the page finished loading
 *      noWait       do not wait for the first page
 */
async function openHome(browser, opt = {}) {
  const ctx = await browser.newContext({
    viewport: opt.viewport || (opt.mobile ? { width: 412, height: 800 } : { width: 1280, height: 900 }),
    isMobile: !!opt.mobile,
    hasTouch: !!opt.mobile,
    deviceScaleFactor: opt.mobile ? 2 : 1,
    locale: opt.locale || 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const server = makeServer(opt.server);
  await ctx.addInitScript((o) => { window.__XOD_TEST__ = o; }, opt.testOpts || {});
  const settings = { lang: 'en', ...(opt.settings || {}) };
  await ctx.addInitScript((s) => {
    try { if (localStorage.getItem('xod-settings') === null) localStorage.setItem('xod-settings', JSON.stringify(s)); } catch (e) { /* ignore */ }
  }, settings);
  if (opt.foreign) await ctx.addInitScript(foreignWrap, 'inner');
  if (opt.extWorldHook) {
    await ctx.addInitScript(() => { window.chrome = window.chrome || {}; window.chrome.runtime = { id: 'test-extension-id' }; });
    await ctx.addInitScript({ content: HOOK });
  } else if (!opt.control && !opt.noHook && !opt.hookLate) await ctx.addInitScript({ content: HOOK });     // like document_start in the page's own world
  if (opt.foreign) await ctx.addInitScript(foreignWrap, 'outer');
  if (!opt.control && !opt.noUi && !opt.lateContent) {
    await ctx.addInitScript(cssInit, CSS);
    await ctx.addInitScript({ content: I18N_JS });
    await ctx.addInitScript({ content: JS });
  }
  await routeMock(ctx, server);
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await attach(page, opt);
  return { ctx, page, errors, server };
}

async function attach(page, opt = {}) {
  await page.goto(`https://x.com/home${opt.query || ''}`, { waitUntil: 'load' });
  if (opt.lateContent && !opt.control) {
    await page.addStyleTag({ content: CSS });
    await page.addScriptTag({ content: I18N_JS });
    await page.addScriptTag({ content: JS });
  }
  if (!opt.noWait) await page.waitForFunction(() => window.__mock && window.__mock.info().items > 0, null, { timeout: 8000 });
  if (opt.hookLate) await page.addScriptTag({ content: HOOK });
  if (!opt.control && !opt.noUi) await page.waitForFunction(() => window.__xod, null, { timeout: 8000 });
  if (!opt.control && !opt.noUi && !opt.noHook) await page.waitForFunction(() => window.__xod.state().ready, null, { timeout: 8000 });
  await sleep(150);
}

const until = (page, fn, arg, timeout = 6000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const st = (page) => page.evaluate(() => window.__xod.state());
const mi = (page) => page.evaluate(() => window.__mock.info());

const panelVisible = (page) => page.evaluate(() => {
  const g = document.getElementById('xod-gate');
  return !!g && g.classList.contains('xod-on') && getComputedStyle(g).visibility === 'visible';
});

// is the last post of the page fully above the panel? (false = the panel covers its lower part)
const lastPostClearOfPanel = (page) => page.evaluate(() => {
  const gate = document.getElementById('xod-gate').getBoundingClientRect();
  const arts = [...document.querySelectorAll('article[data-pid]')].map((a) => a.getBoundingClientRect());
  const last = arts.sort((p, q) => q.bottom - p.bottom)[0];
  return last.bottom <= gate.top + 1;
});

const untilPanel = (page, on, timeout = 3000) => page.waitForFunction((want) => {
  const g = document.getElementById('xod-gate');
  const vis = !!g && g.classList.contains('xod-on') && getComputedStyle(g).visibility === 'visible';
  return vis === want;
}, on, { timeout, polling: 30 });

// scroll to the very end (X's list is re-rendered while we scroll) and let requests and the UI settle
async function gotoEnd(page, { wait = 600 } = {}) {
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => window.__mock.scrollToEnd());
    await sleep(120);
  }
  await sleep(wait);
}

async function wheelDownUntilStuck(page) {
  await page.mouse.move(640, 450);
  let last = -1;
  let same = 0;
  for (let k = 0; k < 500 && same < 10; k++) {
    await page.mouse.wheel(0, 300);
    await sleep(30);
    const y = await page.evaluate(() => window.__pos());
    if (Math.abs(y - last) < 1) same++; else { same = 0; last = y; }
  }
  await sleep(400);
}

// A real touch drag (finger moves up = page scrolls down) through the browser's input pipeline.
async function drag(cdp, x, y0, y1, steps = 12, delay = 16) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / steps }] });
    await sleep(delay);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function swipeUntilStuck(cdp, page) {
  let same = 0;
  let last = -1;
  for (let k = 0; k < 150 && same < 4; k++) {
    await drag(cdp, 206, 500, 150);
    await sleep(220);
    const y = await page.evaluate(() => window.__pos());
    if (Math.abs(y - last) < 1) same++; else { same = 0; last = y; }
  }
  await sleep(500);
}

// ids of the posts that really exist in feed `epoch`, items [from, to)
function pidsOf(epoch, from, to) {
  const out = new Set();
  for (let i = from; i < to; i++) {
    const it = FeedGen.item(epoch, i);
    if (it.type !== 'module') out.add(it.pid);
  }
  return [...out];
}

/* ───────────────────────────────── tests ───────────────────────────────── */

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-smooth-scrolling'],
  });

  /* ───────── the texts: every language complete and consistent ───────── */

  await test('locales: every language has exactly the keys of English, no markup, sane lengths; every key the code uses exists', async () => {
    const problems = I18N.validate(LOCALES);
    eq(problems, [], 'locale problems');
    // every text the script asks for (tx.something, T().something, st_<state>) must exist in the reference language
    const used = new Set();
    for (const m of JS.matchAll(/\b(?:tx|T\(\))\.([A-Za-z_]+)/g)) used.add(m[1]);
    for (const m of JS.matchAll(/T\(\)\[`([a-z]+_)\$\{[a-z]+\}`\]/g)) {
      for (const k of Object.keys(LOCALES.en)) if (k.startsWith(m[1])) used.add(k);
    }
    used.delete('dir');                                          // meta: comes from "_dir"
    const missing = [...used].filter((k) => !(k in LOCALES.en));
    eq(missing, [], 'texts the script uses but locales/en.json does not have');
    const unused = Object.keys(LOCALES.en).filter((k) => !k.startsWith('_') && !used.has(k));
    eq(unused, [], 'texts in locales/en.json that the script never uses (remove them, translators should not work on dead text)');
  });

  /* ───────── the core promise: the server is not asked until you press ───────── */

  await test('control: without the extension X fetches page after page by itself (the harness can see deliveries)', async () => {
    const { ctx, page, server } = await openHome(browser, { control: true });
    try {
      for (let k = 0; k < 6; k++) { await page.evaluate(() => window.__mock.scrollToEnd()); await sleep(350); }
      assert(cursorReqs(server).length >= 3, `expected several next-page requests, saw ${cursorReqs(server).length}`);
    } finally { await ctx.close(); }
  });

  await test('start: the first page is not delayed, nothing is parked, the chip says "active"', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      eq((await mi(page)).items, 20, 'posts of the first batch');
      eq(server.log.length, 1, 'requests so far');
      eq(server.log[0].cursor, null, 'the first request carries no cursor');
      const s = await st(page);
      eq(s.held, [], 'parked requests');
      eq(s.chip, 'on', 'chip state');
      assert(!(await panelVisible(page)), 'the panel must not show at the start');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('parked: at the end of the batch the next-page request is held back and the server is NOT contacted', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      const s = await st(page);
      eq(s.held.length, 1, 'parked requests');
      eq(s.held[0].op, 'HomeTimeline', 'which timeline');
      eq(s.held[0].why, 'bottom', 'the hook recognised the Bottom cursor from the server\'s own reply');
      eq(cursorReqs(server).length, 0, 'next-page requests that really reached the server');
      const m = await mi(page);
      eq(m.items, 20, 'posts delivered');
      assert(m.loading, 'X should still believe the page is loading (it waits for the reply)');
      assert(await panelVisible(page), 'panel not shown');
      eq(s.chip, 'waiting', 'chip state');

      // waiting costs nothing and nothing leaks: more scrolling, more time
      await sleep(1500);
      for (let k = 0; k < 4; k++) { await page.evaluate(() => window.__mock.scrollToEnd()); await sleep(100); }
      eq(cursorReqs(server).length, 0, 'requests after waiting and scrolling more');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('button: releases exactly one page, one request, the posts arrive, the panel goes away; the next page is parked again', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).length, 1, 'requests after the first press');
      eq(cursorReqs(server)[0].status, 200, 'status of the released request');
      await sleep(400);
      let s = await st(page);
      eq(s.held, [], 'nothing parked after the release');
      eq(s.chip, 'on', 'chip state');
      assert(!(await panelVisible(page)), 'panel still visible after the batch arrived');

      // the next batch: parked again, the server stays quiet until the next press
      await gotoEnd(page);
      s = await st(page);
      eq(s.held.length, 1, 'second page parked');
      eq(cursorReqs(server).length, 1, 'requests while the second page waits');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 60);
      eq(cursorReqs(server).length, 2, 'requests after the second press');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('button: pressing twice quickly still asks the server only once', async () => {
    const { ctx, page, server } = await openHome(browser);
    try {
      await gotoEnd(page);
      await page.evaluate(() => { const b = document.getElementById('xod-more'); b.click(); b.click(); b.click(); });
      await until(page, () => window.__mock.info().items >= 40);
      await sleep(500);
      eq(cursorReqs(server).length, 1, 'requests');
    } finally { await ctx.close(); }
  });

  await test('nothing is hidden: every post of both batches is in the page and visible (no hiding at all)', async () => {
    const { ctx, page, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      await sleep(300);
      const seen = await page.evaluate(async () => {
        const out = new Set();
        const hidden = [];
        const max = document.documentElement.scrollHeight;
        for (let y = 0; y <= max; y += 300) {
          scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 45));
          for (const a of document.querySelectorAll('article[data-pid]')) {
            const cell = a.closest('[data-testid="cellInnerDiv"]') || a;
            if (getComputedStyle(cell).visibility === 'hidden') hidden.push(a.dataset.pid);
            out.add(a.dataset.pid);
          }
        }
        return { pids: [...out], hidden, marked: document.querySelectorAll('[data-xod-hide]').length };
      });
      for (const pid of pidsOf(1, 0, 40)) assert(seen.pids.includes(pid), `post ${pid} was never in the page`);
      eq(seen.hidden, [], 'posts with visibility:hidden');
      eq(seen.marked, 0, 'elements marked as hidden by the extension');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  /* ───────── what must keep working: refresh, new posts, tabs ───────── */

  await test('pull-to-refresh: the cursor-less request goes straight through; the old parked request is forgotten', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked before the refresh');
      const before = server.log.length;
      await page.evaluate(() => window.__mock.refresh('ptr'));
      await until(page, () => window.__mock.info().epoch === 2 && window.__mock.info().items === 20);
      eq(server.log.length, before + 1, 'exactly one new request');
      const last = server.log[server.log.length - 1];
      eq([last.cursor, last.ctx], [null, 'ptr'], 'the refresh request');
      await sleep(300);
      eq((await st(page)).held, [], 'the parked request of the old feed must be gone');
      assert(!(await panelVisible(page)), 'the panel still shows for the old feed');

      // the new feed behaves the same way
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'the new feed is parked too');
      eq(cursorReqs(server).length, 0, 'no next-page request reached the server');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('refresh while a page is parked and X does NOT cancel its old request: the button releases the NEW feed\'s page and forgets the stale one', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?keepold=1' });
    try {
      await gotoEnd(page);
      const old = (await st(page)).held;
      eq(old.length, 1, 'parked before the refresh');
      await page.evaluate(() => window.__mock.refresh('ptr'));
      await until(page, () => window.__mock.info().epoch === 2 && window.__mock.info().items === 20);
      await sleep(300);
      assert(!(await panelVisible(page)), 'panel while the new feed is at its top');
      eq(cursorReqs(server).length, 0, 'requests so far');

      await gotoEnd(page);                                       // the new feed asks for its own next page
      await until(page, () => window.__xod.state().held.length === 2);
      assert(await panelVisible(page), 'panel at the end of the new feed');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      const reqs = cursorReqs(server);
      eq(reqs.length, 1, 'requests after the press');
      eq(FeedGen.parseCursor(reqs[0].cursor).epoch, 2, 'the released request belongs to the NEW feed');
      await sleep(300);
      const s = await st(page);
      eq(s.held.filter((e) => e.id === old[0].id), [], 'the stale request is forgotten');
      assert(s.stats.dropped >= 1, `dropped should be counted: ${JSON.stringify(s.stats)}`);
      eq(cursorReqs(server).length, 1, 'the stale request must never be sent');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('only the old request exists after a refresh (X will not ask again, it still thinks it is loading): the button releases it, nothing is stuck', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?keepold=1&autoload=0' });
    try {
      await page.evaluate(() => window.__mock.loadMore());
      await until(page, () => window.__xod.state().held.length === 1);
      await page.evaluate(() => window.__mock.refresh('ptr'));
      await until(page, () => window.__mock.info().epoch === 2 && window.__mock.info().items === 20);
      await sleep(300);
      eq((await st(page)).held.length, 1, 'the old request is the only one waiting');
      await page.evaluate(() => window.__xod.release());
      await until(page, () => window.__xod.state().stats.released === 1);
      await sleep(300);
      eq(cursorReqs(server).length, 1, 'requests');
      eq(FeedGen.parseCursor(cursorReqs(server)[0].cursor).epoch, 1, 'it is the old feed\'s request, sent because nothing newer exists');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('reloading one timeline never touches the other timeline\'s waiting request', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?keepold=1' });
    try {
      await gotoEnd(page);                                      // For you: parked
      await page.click('.tabs [data-op="HomeLatestTimeline"]');
      await until(page, () => window.__mock.info().op === 'HomeLatestTimeline' && window.__mock.info().items === 20);
      await gotoEnd(page);                                      // Following: parked
      eq((await st(page)).held.map((e) => e.op).sort(), ['HomeLatestTimeline', 'HomeTimeline'], 'both parked');
      await page.evaluate(() => window.__mock.refresh('ptr'));  // reload Following
      await until(page, () => window.__mock.info().epoch === 102 && window.__mock.info().items === 20);
      await gotoEnd(page);
      await until(page, () => window.__xod.state().held.filter((e) => e.op === 'HomeLatestTimeline').length === 2);
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      const reqs = cursorReqs(server);
      eq(reqs.map((r) => r.op), ['HomeLatestTimeline'], 'only a Following page was requested');
      eq(FeedGen.parseCursor(reqs[0].cursor).epoch, 102, 'it belongs to the new Following feed');
      await sleep(300);
      eq((await st(page)).held.map((e) => e.op), ['HomeTimeline'], 'the For-you request keeps waiting');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('"N new posts" (Top cursor) is never parked, it is not a next page', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await page.evaluate(() => window.__mock.pollNew());
      await until(page, () => window.__mock.info().items === 23);
      const last = server.log[server.log.length - 1];
      assert(last.cursor && last.cursor.startsWith('DAACT_'), `the poll should carry a Top cursor: ${last.cursor}`);
      eq(last.status, 200, 'status');
      eq((await st(page)).held, [], 'parked requests');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('Following tab: its first page passes, its next page is parked on its own, the button serves the tab on screen', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      eq((await st(page)).held.map((e) => e.op), ['HomeTimeline'], 'For you is parked');
      await page.click('.tabs [data-op="HomeLatestTimeline"]');
      await until(page, () => window.__mock.info().op === 'HomeLatestTimeline' && window.__mock.info().items === 20);
      const first = server.log[server.log.length - 1];
      eq([first.op, first.cursor], ['HomeLatestTimeline', null], 'the Following first page went straight through');
      await sleep(400);
      let s = await st(page);
      eq(s.activeOp, 'HomeLatestTimeline', 'the timeline on screen, as the extension sees it');
      assert(!(await panelVisible(page)), 'the For-you request must not raise the panel on the Following tab');

      await gotoEnd(page);
      s = await st(page);
      eq(s.held.map((e) => e.op).sort(), ['HomeLatestTimeline', 'HomeTimeline'], 'both timelines are parked');
      assert(await panelVisible(page), 'panel for Following');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).map((r) => r.op), ['HomeLatestTimeline'], 'only the Following page was requested');
      eq((await st(page)).held.map((e) => e.op), ['HomeTimeline'], 'For you is still waiting');

      // back on For you: its page is still waiting, the same button serves it
      await page.click('.tabs [data-op="HomeTimeline"]');
      await sleep(500);
      await gotoEnd(page);
      assert(await panelVisible(page), 'panel for For you');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().op === 'HomeTimeline' && window.__mock.info().items >= 40);
      eq(cursorReqs(server).map((r) => r.op), ['HomeLatestTimeline', 'HomeTimeline'], 'then the For-you page');
      eq((await st(page)).held, [], 'nothing left parked');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('GET variant (Following sends ?variables=...): parsed and parked the same way', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?get=1' });
    try {
      await page.click('.tabs [data-op="HomeLatestTimeline"]');
      await until(page, () => window.__mock.info().op === 'HomeLatestTimeline' && window.__mock.info().items === 20);
      eq(server.log[server.log.length - 1].method, 'GET', 'first page method');
      await gotoEnd(page);
      const s = await st(page);
      eq(s.held.map((e) => e.op), ['HomeLatestTimeline'], 'parked');
      eq(cursorReqs(server).length, 0, 'next-page requests that reached the server');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      const r = cursorReqs(server);
      eq(r.length, 1, 'requests after the press');
      eq(r[0].method, 'GET', 'method of the released request');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('fetch variant (the app uses fetch, not XHR): parked, released, and cancelled by an AbortController', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?net=fetch' });
    try {
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked');
      eq(cursorReqs(server).length, 0, 'requests while parked');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).length, 1, 'requests after the press');

      // a refresh aborts the pending fetch: the parked entry must disappear
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked again');
      await page.evaluate(() => window.__mock.refresh('ptr'));
      await until(page, () => window.__mock.info().epoch === 2 && window.__mock.info().items === 20);
      await sleep(300);
      eq((await st(page)).held, [], 'the aborted fetch was forgotten');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  /* ───────── things that go wrong ───────── */

  await test('a failed page: X shows its own Retry and that retry goes straight through; afterwards pages are parked again', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      server.failNext = 1;
      await gotoEnd(page);
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().failed === true);
      eq(cursorReqs(server).map((r) => r.status), [500], 'the released request was answered with an error');
      await sleep(200);
      eq((await st(page)).chip, 'failed', 'chip state');
      await page.click('[data-testid="retry"]');
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).map((r) => r.status), [500, 200], 'the retry reached the server at once');
      eq((await st(page)).held, [], 'nothing parked');

      // the free pass is used up
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked again after the retry');
      eq(cursorReqs(server).length, 2, 'no extra request');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('a parked request that X cancels itself is forgotten (and X asking again is parked again); nothing is ever sent', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      const first = (await st(page)).held;
      eq(first.length, 1, 'parked');
      await page.evaluate(() => window.__mock.abortPending());
      await until(page, (id) => !window.__xod.state().held.some((e) => e.id === id), first[0].id);
      const s = await st(page);
      assert(s.stats.dropped >= 1, `the cancelled request should be counted as dropped: ${JSON.stringify(s.stats)}`);
      // the app notices it has nothing loading and asks for the next page again: that new request is parked as well
      await until(page, () => window.__xod.state().held.length === 1);
      assert(await panelVisible(page), 'panel for the new request');
      eq(cursorReqs(server).length, 0, 'requests that reached the server');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('the panel goes away when the parked request disappears and X does not ask again', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?autoload=0' });
    try {
      // with autoload=0 the page asks only when told to: ask once, park, then cancel
      await page.evaluate(() => window.__mock.scrollToEnd());
      await page.evaluate(() => window.__mock.loadMore());
      await until(page, () => window.__xod.state().held.length === 1);
      await gotoEnd(page);
      await untilPanel(page, true);
      await page.evaluate(() => window.__mock.abortPending());
      await until(page, () => window.__xod.state().held.length === 0);
      await untilPanel(page, false);
      eq(cursorReqs(server).length, 0, 'requests that reached the server');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('unusual requests fail open: other operations, unreadable bodies and refresh-style requests are never parked', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      // 1. another GraphQL operation, even with a cursor-like field
      const r1 = await page.evaluate(() => new Promise((res) => {
        const x = new XMLHttpRequest();
        x.open('POST', 'https://x.com/i/api/graphql/abc/TweetDetail');
        x.onloadend = () => res(x.status);
        x.send(JSON.stringify({ variables: { cursor: 'DAACxxxxxxxxxxxx' } }));
      }));
      eq(r1, 200, 'TweetDetail');
      // 2. a Home request whose body is not JSON
      const r2 = await page.evaluate(() => new Promise((res) => {
        const x = new XMLHttpRequest();
        x.open('POST', 'https://x.com/i/api/graphql/abc/HomeTimeline');
        x.onloadend = () => res(x.status);
        x.send('variables=this-is-not-json');
      }));
      eq(r2, 200, 'unreadable body');
      // 3. an unknown cursor in a refresh-style request
      const r3 = await page.evaluate(() => window.__mock.raw('HomeTimeline', 'DAACB_HomeTimeline_9_0_AAAAAAAAAA', 'ptr').then(() => 'ok', (e) => e.message));
      eq(r3, 'ok', 'refresh-style request with an unknown cursor');
      const seen = server.log.map((r) => `${r.op}:${r.cursor ? 'c' : '-'}`);
      assert(seen.includes('TweetDetail:c'), `TweetDetail did not reach the server: ${seen}`);
      assert(seen.filter((x) => x === 'HomeTimeline:-').length >= 2, `the unreadable request did not reach the server: ${seen}`);
      assert(server.log.some((r) => r.cursor === 'DAACB_HomeTimeline_9_0_AAAAAAAAAA' && r.ctx === 'ptr'), 'the refresh-style request did not reach the server');
      eq((await st(page)).held, [], 'nothing parked');

      // 4. the same unknown cursor as an ordinary next-page request IS parked (it is what a missed reply looks like)
      const p = page.evaluate(() => window.__mock.raw('HomeTimeline', 'DAACB_HomeTimeline_9_0_AAAAAAAAAAAA', 'launch').then(() => 'ok', (e) => e.message));
      await sleep(500);
      const s = await st(page);
      eq(s.held.map((e) => e.why), ['unknown'], 'parked as an unknown next-page cursor');
      assert(!server.log.some((r) => r.cursor === 'DAACB_HomeTimeline_9_0_AAAAAAAAAAAA'), 'it must not have reached the server');
      await page.evaluate(() => window.__xod.release());
      eq(await p, 'ok', 'released request resolved');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('XHR keeps its normal behaviour for everything else (events, abort, status)', async () => {
    const { ctx, page, errors } = await openHome(browser);
    try {
      const out = await page.evaluate(() => new Promise((res) => {
        const log = [];
        const x = new XMLHttpRequest();
        x.open('POST', 'https://x.com/i/api/graphql/abc/UserTweets');
        x.onreadystatechange = () => log.push(`rs${x.readyState}`);
        x.onload = () => { log.push(`load${x.status}`); };
        x.onloadend = () => {
          const y = new XMLHttpRequest();
          y.open('GET', 'https://x.com/i/api/graphql/abc/Other?v=1');
          y.onabort = () => { log.push('abort'); res(log); };
          y.send();
          y.abort();
        };
        x.send('{}');
      }));
      eq(out, ['rs2', 'rs3', 'rs4', 'load200', 'abort'], 'event sequence of an ordinary request and an aborted one');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('hook injected twice (e.g. the extension reloaded): still exactly one parked request and one release', async () => {
    const { ctx, page, server } = await openHome(browser);
    try {
      await page.addScriptTag({ content: HOOK });
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked once');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).length, 1, 'requests');
    } finally { await ctx.close(); }
  });

  await test('hook installed late (X had already sent its first request): the next page is still parked', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { hookLate: true });
    try {
      await gotoEnd(page);
      const s = await st(page);
      eq(s.held.map((e) => e.why), ['unknown'], 'parked even though the hook never saw the cursor');
      eq(cursorReqs(server).length, 0, 'requests that reached the server');
      assert(s.stats && s.stats.late >= 1, `the diagnostics should report a request made before the hook: ${JSON.stringify(s.stats)}`);
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      // from now on the cursors come from replies the hook has seen
      await gotoEnd(page);
      eq((await st(page)).held.map((e) => e.why), ['bottom'], 'recognised by cursor now');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('content script installed after the page loaded (not at document_start) works the same', async () => {
    const { ctx, page, server } = await openHome(browser, { lateContent: true });
    try {
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked');
      eq(cursorReqs(server).length, 0, 'requests');
      assert(await panelVisible(page), 'panel');
    } finally { await ctx.close(); }
  });

  await test('hook missing: the chip warns after a moment, X keeps working normally', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { noHook: true, testOpts: { graceMs: 600 } });
    try {
      await sleep(1300);
      const s = await st(page);
      eq(s.chip, 'broken', 'chip state');
      assert((await page.textContent('#xod-count')).includes('⚠'), 'warning sign');
      for (let k = 0; k < 4; k++) { await page.evaluate(() => window.__mock.scrollToEnd()); await sleep(350); }
      assert(cursorReqs(server).length >= 2, 'pages must load freely when the hook is missing');
      assert(!(await panelVisible(page)), 'no panel without a hook');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('hook alive but X sends no timeline request at all: the chip says nothing was intercepted', async () => {
    const { ctx, page, errors } = await openHome(browser, { query: '?start=0', noWait: true, testOpts: { silentMs: 900 } });
    try {
      eq((await st(page)).chip, 'on', 'chip right after the start');
      await sleep(1700);
      eq((await st(page)).chip, 'silent', 'chip state after a while');
      assert((await page.textContent('#xod-count')).includes('⚠'), 'warning sign');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('no false alarm: once X\'s first page went through the hook, the chip never claims "nothing intercepted"', async () => {
    const { ctx, page, errors } = await openHome(browser, { testOpts: { silentMs: 900 } });
    try {
      await sleep(2000);                                // well past the "silent" deadline, the user just reads
      const s = await st(page);
      eq(s.chip, 'on', 'chip state');
      assert(s.stats.seen >= 1, `the page should know the hook saw X's first request: ${JSON.stringify(s.stats)}`);
      assert(!(await page.textContent('#xod-count')).includes('⚠'), 'warning sign on a working setup');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  /* ───────── finding the timeline on screen, and never leaving the reader stuck ───────── */

  await test('a pinned list (third tab) on screen: no panel for the parked For-you page; back on For you the panel returns', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?tabs=3' });
    try {
      await gotoEnd(page);
      eq((await st(page)).held.map((e) => e.op), ['HomeTimeline'], 'For you is parked');
      assert(await panelVisible(page), 'panel on For you');
      await page.click('.tabs [data-op="List"]');
      await sleep(500);
      const s = await st(page);
      eq(s.activeOp, 'other', 'a further tab is "other"');
      assert(!(await panelVisible(page)), 'no panel on a list');
      eq(s.chip, 'on', 'the chip must not claim that something is waiting');
      await page.click('.tabs [data-op="HomeTimeline"]');
      await sleep(500);
      await gotoEnd(page);
      assert(await panelVisible(page), 'panel again on For you');
      eq(cursorReqs(server).length, 0, 'nothing reached the server meanwhile');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('tab strip in unfamiliar markup (outside <main>): still read; a third tab there is not guessed to be a list', async () => {
    const { ctx, page, errors } = await openHome(browser, { query: '?tabloc=body&tabs=3' });
    try {
      eq((await st(page)).activeOp, 'HomeTimeline', 'For you, found outside <main>');
      await page.click('.tabs [data-op="HomeLatestTimeline"]');
      await until(page, () => window.__mock.info().op === 'HomeLatestTimeline' && window.__mock.info().items === 20);
      await sleep(300);
      eq((await st(page)).activeOp, 'HomeLatestTimeline', 'Following');
      await page.click('.tabs [data-op="List"]');
      await sleep(300);
      eq((await st(page)).activeOp, null, 'unknown markup: no guess for a third tab');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('no tab strip to read (as on the phone): any parked request counts and the button serves the newest one', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?tabloc=none' });
    try {
      eq((await st(page)).activeOp, null, 'nothing to read');
      await gotoEnd(page);
      eq((await st(page)).held.map((e) => e.op), ['HomeTimeline'], 'For you is parked');
      assert(await panelVisible(page), 'panel without a tab strip');
      await page.click('.tabs [data-op="HomeLatestTimeline"]');
      await until(page, () => window.__mock.info().op === 'HomeLatestTimeline' && window.__mock.info().items === 20);
      await gotoEnd(page);
      eq((await st(page)).held.map((e) => e.op).sort(), ['HomeLatestTimeline', 'HomeTimeline'], 'both timelines are parked');
      assert(await panelVisible(page), 'panel');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).map((r) => r.op), ['HomeLatestTimeline'], 'the newest one (the tab being read) was served');
      eq((await st(page)).held.map((e) => e.op), ['HomeTimeline'], 'the other one is still waiting');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('hook file run in the extension\'s own world (a browser that ignores "world": "MAIN"): it patches nothing and never says "ready"', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { extWorldHook: true, noHook: true, testOpts: { graceMs: 600 } });
    try {
      const probe = await page.evaluate(() => ({
        flag: !!window.__xodHook,
        xhrNative: /\[native code\]/.test(Function.prototype.toString.call(XMLHttpRequest.prototype.open)),
        fetchNative: /\[native code\]/.test(Function.prototype.toString.call(window.fetch)),
      }));
      eq(probe, { flag: false, xhrNative: true, fetchNative: true }, 'the hook must not patch anything there');
      await sleep(1300);
      eq((await st(page)).chip, 'broken', 'no hook answered, so the chip warns');
      for (let k = 0; k < 4; k++) { await page.evaluate(() => window.__mock.scrollToEnd()); await sleep(350); }
      assert(cursorReqs(server).length >= 2, 'X must keep loading pages freely');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('safety valve: a page is parked but the page structure is gone (X changed its markup): after a while everything flows, nothing stays stuck; when the markup returns, parking resumes', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { testOpts: { mainMissingMs: 800 } });
    try {
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked');
      assert(await panelVisible(page), 'panel');
      await page.evaluate(() => {                       // X "redesigns": no <main>, no primary column
        const m = document.querySelector('main[role="main"]');
        const d = document.createElement('div');
        d.id = 'main-gone';
        while (m.firstChild) d.appendChild(m.firstChild);
        d.firstElementChild.removeAttribute('data-testid');
        m.replaceWith(d);
      });
      await until(page, () => window.__xod.state().failOpen === true, null, 5000);
      await until(page, () => window.__xod.state().held.length === 0, null, 3000);
      await until(page, () => window.__mock.info().items >= 40, null, 4000);
      eq(cursorReqs(server).length, 1, 'X received its page exactly once');
      assert(!(await panelVisible(page)), 'no panel without a place for it');
      assert((await page.evaluate(() => window.__xod.diag())).includes('FAIL-OPEN'), 'the diagnostics say so');

      await page.evaluate(() => {                       // the markup comes back
        const d = document.getElementById('main-gone');
        const m = document.createElement('main');
        m.setAttribute('role', 'main');
        while (d.firstChild) m.appendChild(d.firstChild);
        m.firstElementChild.setAttribute('data-testid', 'primaryColumn');
        d.replaceWith(m);
      });
      await until(page, () => window.__xod.state().failOpen === false, null, 4000);
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked again once the interface can attach');
      assert(await panelVisible(page), 'panel is back');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  for (const net of ['xhr', 'fetch']) {
    await test(`other extensions that wrap ${net === 'xhr' ? 'XMLHttpRequest' : 'fetch'} too (one before, one after this one): still parked, still released, their wrappers keep running`, async () => {
      const { ctx, page, server, errors } = await openHome(browser, { foreign: true, query: `?net=${net}` });
      try {
        const calls = (what) => page.evaluate((w) => window.__foreign.filter((x) => x === w).length, what);
        const kind = net === 'xhr' ? 'send' : 'fetch';
        const firstOuter = await calls(`outer:${kind}`);
        const firstInner = await calls(`inner:${kind}`);
        assert(firstOuter >= 1 && firstOuter === firstInner, `the first page must pass through both wrappers (${firstOuter}/${firstInner})`);
        await gotoEnd(page);
        eq((await st(page)).held.length, 1, 'the next page is parked');
        eq(cursorReqs(server).length, 0, 'the server must not be asked');
        eq([await calls(`outer:${kind}`), await calls(`inner:${kind}`)], [firstOuter + 1, firstInner], 'the outer wrapper saw the call, the inner one only gets what is really sent');
        await page.click('#xod-more');
        await until(page, () => window.__mock.info().items >= 40);
        eq(cursorReqs(server).length, 1, 'requests after the press');
        eq([await calls(`outer:${kind}`), await calls(`inner:${kind}`)], [firstOuter + 1, firstInner + 1], 'after the release both wrappers have seen it');
        noErrors(errors);
      } finally { await ctx.close(); }
    });
  }

  await test('the button is not re-armed by an unrelated state message that arrives before the hook answered the press', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      await page.evaluate(() => {
        window.__seen = [];
        window.addEventListener('message', (ev) => {
          const d = ev.data;
          if (d && d.__xod === 'xod-1' && d.from === 'hook' && d.type === 'state') window.__seen.push({ ack: d.ack, synthetic: !!d.synthetic, pressed: window.__xod.state().pressed });
        });
      });
      await page.evaluate(() => {
        window.__xod.release();
        // an old-looking state message (it does not acknowledge the press) slips in before the hook's own answer
        window.postMessage({ __xod: 'xod-1', from: 'hook', type: 'state', synthetic: true, ack: 0, held: [{ id: 99, op: 'HomeTimeline', why: 'bottom', cursor: '', age: 0 }], inflight: 0, stats: { seen: 5 } }, location.origin);
      });
      await sleep(400);
      const seen = await page.evaluate(() => window.__seen);
      const fake = seen.find((x) => x.synthetic);
      const real = seen.find((x) => !x.synthetic && x.ack >= 1);
      assert(fake && real, `both state messages should have been seen: ${JSON.stringify(seen)}`);
      eq(fake.pressed, true, 'pressed right after the unrelated message');
      eq(real.pressed, false, 'pressed after the hook acknowledged the press');
      eq(cursorReqs(server).length, 1, 'requests');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  /* ───────── never leaving the reader stuck, part 2: a dead interface, requests without an end, odd tab strips ───────── */

  await test('interface gone (extension updated or disabled while a page is parked): the hook asks, hears nothing, lets the page through once and parks nothing more; a live interface is never mistaken for a dead one', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { testOpts: { uiSilentMs: 1500, watchMs: 150 } });
    try {
      await page.evaluate(() => {
        window.__msgs = [];
        window.addEventListener('message', (ev) => {
          const d = ev.data;
          if (d && d.__xod === 'xod-1') window.__msgs.push({ from: d.from, type: d.type, gone: d.gone });
        });
      });
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked');
      // a live interface answers every ping at once, so a wait longer than the silence limit changes nothing
      await sleep(2600);
      eq((await st(page)).held.length, 1, 'still parked after a long wait with a live interface');
      eq(cursorReqs(server).length, 0, 'the server was not asked');
      const seen = await page.evaluate(() => ({
        pings: window.__msgs.filter((m) => m.from === 'hook' && m.type === 'ping').length,
        pongs: window.__msgs.filter((m) => m.from === 'ui' && m.type === 'pong').length,
      }));
      assert(seen.pings >= 3 && seen.pongs >= 3, `the hook should ask and the interface answer: ${JSON.stringify(seen)}`);

      await page.evaluate(() => window.__xod.kill());            // as if the extension had been disabled: nobody answers any more
      await until(page, () => window.__mock.info().items >= 40, null, 6000);
      eq(cursorReqs(server).length, 1, 'X received its page exactly once');
      assert(await page.evaluate(() => window.__msgs.some((m) => m.from === 'hook' && m.type === 'state' && m.gone === true)), 'the hook reports that the interface is gone');

      // nothing is parked any more: X loads pages by itself, as without the extension
      for (let k = 0; k < 4; k++) { await page.evaluate(() => window.__mock.scrollToEnd()); await sleep(450); }
      assert(cursorReqs(server).length >= 2, `X must be free to keep loading (${cursorReqs(server).length} requests)`);

      // the interface speaks again (here: a message, as the dead one cannot): the hook takes notice
      const before = await page.evaluate(() => window.__msgs.length);
      await page.evaluate(() => window.postMessage({ __xod: 'xod-1', from: 'ui', type: 'pong' }, location.origin));
      await until(page, (n) => window.__msgs.slice(n).some((m) => m.from === 'hook' && m.type === 'state' && m.gone === false), before, 3000);
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('no interface at all (the content script never ran): nothing is parked, X loads its pages by itself', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { noUi: true });
    try {
      for (let k = 0; k < 4; k++) { await page.evaluate(() => window.__mock.scrollToEnd()); await sleep(450); }
      assert(cursorReqs(server).length >= 2, `X must load pages freely (${cursorReqs(server).length} requests)`);
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('a released request that never ends (stuck connection): the button is not blocked for good, and the reply still lands when it comes', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { testOpts: { inflightMaxMs: 900, watchMs: 150 } });
    try {
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked');
      server.latency = 3500;                                      // the reply will take very long
      await page.click('#xod-more');
      await until(page, () => window.__xod.state().inflight === 1, null, 3000);
      eq((await st(page)).chip, 'loading', 'loading while the request is out');
      await until(page, () => window.__xod.state().inflight === 0, null, 3000);   // given up waiting for an end
      const s = await st(page);
      eq(s.chip, 'on', 'the chip no longer says loading');
      eq(s.pressed, false, 'the button is free again');
      await until(page, () => window.__mock.info().items >= 40, null, 6000);      // X still gets its page when the server answers
      eq(cursorReqs(server).length, 1, 'requests');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('a cursor the hook has never seen is parked on purpose ("unknown"), and the button releases it', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?autoload=0' });
    try {
      await page.evaluate(() => {
        const x = new XMLHttpRequest();
        x.open('POST', '/i/api/graphql/zzz/HomeTimeline');
        x.setRequestHeader('content-type', 'application/json');
        x.send(JSON.stringify({ variables: { cursor: 'never-seen-before', count: 20, requestContext: 'launch' } }));
      });
      await until(page, () => window.__xod.state().held.length === 1, null, 3000);
      const s = await st(page);
      eq([s.held[0].op, s.held[0].why], ['HomeTimeline', 'unknown'], 'parked as unknown');
      eq(cursorReqs(server).length, 0, 'not sent');
      await page.evaluate(() => window.__xod.release());
      await until(page, () => window.__xod.state().stats.released === 1, null, 3000);
      await sleep(300);
      eq(cursorReqs(server).length, 1, 'the button sent it');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('X re-opens an XMLHttpRequest that is still loading (the browser ends it silently): the button is free again at once', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?autoload=0' });
    try {
      await page.evaluate(() => {
        const x = new XMLHttpRequest();
        window.__x1 = x;
        x.open('POST', '/i/api/graphql/zzz/HomeTimeline');
        x.setRequestHeader('content-type', 'application/json');
        x.send(JSON.stringify({ variables: { cursor: 'never-seen-before', count: 20, requestContext: 'launch' } }));
      });
      await until(page, () => window.__xod.state().held.length === 1, null, 3000);
      server.latency = 1500;
      await page.evaluate(() => window.__xod.release());
      await until(page, () => window.__xod.state().inflight === 1, null, 3000);
      await page.evaluate(() => { window.__x1.open('GET', '/i/api/something-else'); });      // X re-uses the object
      await until(page, () => window.__xod.state().inflight === 0, null, 2000);
      eq((await st(page)).pressed, false, 'the button is free');
      await sleep(1700);                                          // let the abandoned request end on the server's side
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('an XMLHttpRequest object that X re-uses for several timeline requests: each reply is read once, not once more every time', async () => {
    const { ctx, page, errors } = await openHome(browser, { query: '?autoload=0' });
    try {
      const run = () => page.evaluate(() => new Promise((resolve) => {
        const x = window.__reused || (window.__reused = new XMLHttpRequest());
        x.onload = () => resolve(true);
        x.open('POST', '/i/api/graphql/zzz/HomeLatestTimeline');
        x.setRequestHeader('content-type', 'application/json');
        x.send(JSON.stringify({ variables: { count: 20, requestContext: 'launch' } }));
      }));
      const reads = async () => {
        await page.evaluate(() => {
          window.__log = null;
          window.addEventListener('message', function once(ev) {
            const d = ev.data;
            if (d && d.__xod === 'xod-1' && d.from === 'hook' && d.type === 'log') { window.__log = d; window.removeEventListener('message', once); }
          });
          window.postMessage({ __xod: 'xod-1', from: 'ui', type: 'getlog' }, location.origin);
        });
        await until(page, () => window.__log, null, 2000);
        return page.evaluate(() => window.__log.events.filter((e) => e.k === 'cursors').length);
      };
      const base = await reads();
      await run(); await run(); await run();
      eq((await reads()) - base, 3, 'one reading per reply (a re-used object must not collect more listeners each time)');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('tab strip in the opposite order (X changed it): a parked request is still shown, and the button releases it', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { query: '?tabswap=1' });
    try {
      eq((await st(page)).activeOp, 'HomeLatestTimeline', 'read in the usual order, the strip names the other timeline');
      await gotoEnd(page);
      eq((await st(page)).held.map((e) => e.op), ['HomeTimeline'], 'For you is parked');
      assert(await panelVisible(page), 'the panel must appear although the strip names the other timeline');
      eq((await st(page)).chip, 'waiting', 'chip');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).map((r) => r.op), ['HomeTimeline'], 'the right timeline was served');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('forged or damaged messages from the page cannot break the interface or the diagnostics', async () => {
    const { ctx, page, errors } = await openHome(browser);
    try {
      await page.evaluate(() => {
        const send = (m) => window.postMessage({ __xod: 'xod-1', from: 'hook', ...m }, location.origin);
        send({ type: 'log' });
        send({ type: 'log', cursors: 5, ops: [1, [2], 'x'], events: [null, 7, { k: 'req' }], held: 'x', stats: 'y', gone: 'yes' });
        send({ type: 'state', held: [null, 5, 'x', { op: 'HomeTimeline' }], inflight: 'many', stats: 7, ack: 'a' });
        send({ type: 'done', ok: 'maybe' });
        send({ type: 'nonsense' });
      });
      await sleep(300);
      const text = await page.evaluate(() => window.__xod.diag());
      assert(text.includes('OnDemand for X'), `the diagnostics must stay readable:\n${text}`);
      await page.evaluate(() => window.__xod.tick());
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  /* ───────── on / off ───────── */

  await test('switching off: the parked page is released at once; nothing is parked while off; on again parks again', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked');
      await page.evaluate(() => window.__xod.set({ enabled: false }));
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).length, 1, 'the parked page was delivered');
      eq((await st(page)).chip, 'off', 'chip state');
      await untilPanel(page, false);

      await page.evaluate(() => window.__xod.set({ enabled: true }));
      await sleep(300);
      await gotoEnd(page);
      eq((await st(page)).held.length, 1, 'parked again after switching on');
      eq(cursorReqs(server).length, 1, 'requests');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('saved as off: pages flow freely like on stock X', async () => {
    const { ctx, page, server } = await openHome(browser, { settings: { enabled: false } });
    try {
      eq((await st(page)).chip, 'off', 'chip state');
      for (let k = 0; k < 6; k++) { await page.evaluate(() => window.__mock.scrollToEnd()); await sleep(350); }
      assert(cursorReqs(server).length >= 3, `pages should load freely, saw ${cursorReqs(server).length}`);
      eq((await st(page)).held, [], 'parked requests');
    } finally { await ctx.close(); }
  });

  await test('settings sheet: the switch turns it off and on, the choice survives a reload', async () => {
    const { ctx, page, errors } = await openHome(browser);
    try {
      await page.click('#xod-gear');
      eq(await page.getAttribute('#xod-switch', 'aria-checked'), 'true', 'switch at the start');
      await page.click('#xod-switch');
      await sleep(200);
      eq(await page.getAttribute('#xod-switch', 'aria-checked'), 'false', 'switch after the click');
      eq(JSON.parse(await page.evaluate(() => localStorage.getItem('xod-settings'))).enabled, false, 'saved');
      eq((await st(page)).chip, 'off', 'chip');
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.__xod && window.__xod.state().ready, null, { timeout: 8000 });
      await sleep(300);
      eq((await st(page)).chip, 'off', 'still off after the reload');
      await page.click('#xod-gear');
      await page.click('#xod-switch');
      await sleep(200);
      eq((await st(page)).chip, 'on', 'on again');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  /* ───────── words, theme, diagnostics ───────── */

  await test('language: Arabic (RTL) and English on request; follows X\'s theme', async () => {
    const { ctx, page } = await openHome(browser, { settings: { lang: 'ar' }, query: '?theme=dark' });
    try {
      eq(await page.getAttribute('#xod-root', 'dir'), 'rtl', 'direction');
      eq(await page.textContent('#xod-count'), 'مفعّلة', 'chip text (Arabic)');
      await gotoEnd(page);
      eq(await page.textContent('#xod-gate .xod-title'), 'خلصت الدفعة', 'Arabic title');
      eq(await page.textContent('#xod-more'), 'جيب دفعة جديدة', 'Arabic button');
      assert((await page.textContent('#xod-gate .xod-hint')).includes('تويتر ما أرسل لك شي زيادة'), 'Arabic hint');
      assert(await page.evaluate(() => document.getElementById('xod-root').classList.contains('xod-dark')), 'dark theme not detected');
      await page.click('#xod-gate-settings');
      await page.selectOption('#xod-lang', 'en');
      await sleep(200);
      eq(await page.getAttribute('#xod-root', 'dir'), 'ltr', 'direction after switching');
      eq(await page.textContent('#xod-gate .xod-title'), 'Batch finished', 'English title');
      eq(await page.textContent('#xod-more'), 'Load a new batch', 'English button');
      await page.evaluate(() => window.__mock.setTheme('light'));
      await page.evaluate(() => window.__xod.tick());
      assert(!(await page.evaluate(() => document.getElementById('xod-root').classList.contains('xod-dark'))), 'light theme not detected');
      await page.evaluate(() => window.__mock.setTheme('dim'));
      await page.evaluate(() => window.__xod.tick());
      assert(await page.evaluate(() => document.getElementById('xod-root').classList.contains('xod-dark')), 'dim theme not detected as dark');
    } finally { await ctx.close(); }
  });

  await test('languages: each one shows its own texts, direction and name; nothing is missing, raw or "undefined"', async () => {
    const { ctx, page, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      assert(await panelVisible(page), 'panel');
      await page.click('#xod-gate-settings');
      const codes = Object.keys(LOCALES);
      assert(codes.length >= 14, `languages: ${codes}`);
      for (const code of codes) {
        const L = LOCALES[code];
        await page.evaluate((c) => window.__xod.set({ lang: c }), code);
        await sleep(120);
        const got = await page.evaluate(() => {
          const txt = (sel) => document.querySelector(sel).textContent;
          return {
            dir: document.getElementById('xod-root').getAttribute('dir'),
            lang: document.getElementById('xod-root').getAttribute('lang'),
            title: txt('#xod-gate .xod-title'), hint: txt('#xod-gate .xod-hint'), more: txt('#xod-more'),
            sheet: txt('#xod-sheet .xod-h'), enabled: txt('#xod-sheet .xod-row:nth-of-type(2) .xod-label'),
            language: txt('#xod-sheet .xod-row:nth-of-type(3) .xod-label'),
            options: [...document.querySelectorAll('#xod-lang option')].map((o) => [o.value, o.textContent]),
            diag: txt('#xod-diag-box summary'), foot: txt('#xod-sheet > .xod-foot'),
            all: document.getElementById('xod-root').textContent,
          };
        });
        eq([got.dir, got.lang], [L._dir, code], `${code}: direction and language attributes`);
        eq([got.title, got.hint, got.more], [L.gateTitle, L.gateHint, L.more], `${code}: panel texts`);
        eq([got.sheet, got.enabled, got.language, got.diag, got.foot], [L.title, L.enabled, L.language, L.diag, L.foot], `${code}: settings texts`);
        eq(got.options, [['auto', L.langAuto], ...codes.map((c) => [c, LOCALES[c]._name])], `${code}: language picker (every language under its own name)`);
        assert(!/undefined|\[object|\bst_[a-z]+\b|\bgateTitle\b/.test(got.all), `${code}: raw or missing text in the interface`);
        for (const state of ['on', 'waiting', 'loading', 'off', 'failed', 'broken', 'silent']) {
          await page.evaluate((x) => window.__xod.previewChip(x), state);
          eq(await page.textContent('#xod-count'), L[`st_${state}`], `${code}: chip text for "${state}"`);
        }
      }
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('language "auto": the language X is shown in, else the browser\'s languages, else English', async () => {
    const cases = [
      { query: '?xlang=fr', locale: 'en-US', want: 'fr', why: 'X is in French' },
      { query: '?xlang=none', locale: 'tr-TR', want: 'tr', why: 'no X language: the browser is Turkish' },
      { query: '?xlang=xx', locale: 'es-MX', want: 'es', why: 'X language unknown: the browser is Spanish' },
      { query: '?xlang=none', locale: 'sv-SE', want: 'en', why: 'nothing supported: English' },
      { query: '?xlang=ar-SA', locale: 'en-US', want: 'ar', why: 'a regional code finds its language' },
      { query: '?xlang=none', locale: 'de-DE', want: 'de', why: 'the browser is German' },
      { query: '?xlang=ja', locale: 'en-US', want: 'ja', why: 'X is in Japanese' },
      { query: '?xlang=zh', locale: 'en-US', want: 'zh-CN', why: 'X writes Simplified Chinese as "zh"' },
      { query: '?xlang=zh-Hant', locale: 'en-US', want: 'zh-TW', why: 'X is in Traditional Chinese' },
      { query: '?xlang=none', locale: 'zh-HK', want: 'zh-TW', why: 'a Hong Kong browser gets Traditional Chinese' },
      { query: '?xlang=pt', locale: 'en-US', want: 'pt-BR', why: 'Portuguese finds the Brazilian texts' },
      { query: '?xlang=none', locale: 'ru-RU', want: 'ru', why: 'the browser is Russian' },
    ];
    for (const c of cases) {
      const { ctx, page, errors } = await openHome(browser, { settings: { lang: 'auto' }, query: c.query, locale: c.locale });
      try {
        eq(await page.evaluate(() => window.__xod.lang()), c.want, c.why);
        eq(await page.getAttribute('#xod-root', 'dir'), LOCALES[c.want]._dir, `${c.why}: direction`);
        noErrors(errors);
      } finally { await ctx.close(); }
    }
  });

  await test('language tags: regional and old codes find our texts (zh-Hant, pt-PT, in, ko_KR, Hans …)', async () => {
    const { ctx, page } = await openHome(browser);
    try {
      const cases = {
        'ar-SA': 'ar', 'AR': 'ar', 'en-GB': 'en', 'de-AT': 'de', 'pt-PT': 'pt-BR', 'pt-br': 'pt-BR', 'pt': 'pt-BR',
        'zh': 'zh-CN', 'zh-CN': 'zh-CN', 'zh-Hans': 'zh-CN', 'zh-Hans-CN': 'zh-CN', 'zh-SG': 'zh-CN',
        'zh-TW': 'zh-TW', 'zh-tw': 'zh-TW', 'zh-HK': 'zh-TW', 'zh-MO': 'zh-TW', 'zh-Hant': 'zh-TW', 'zh-Hant-HK': 'zh-TW',
        'in': 'id', 'id-ID': 'id', 'ko_KR': 'ko', 'th-TH': 'th', 'ja-JP': 'ja', 'ru-UA': 'ru', 'tr': 'tr', 'es-419': 'es', 'fr-CA': 'fr',
        'sv': '', 'hi-IN': '', 'xx': '', '': '', 'undefined': '',
      };
      const got = await page.evaluate((tags) => Object.fromEntries(Object.keys(tags).map((t) => [t, window.__xod.matchLang(t)])), cases);
      eq(got, cases, 'language tag -> our code');
    } finally { await ctx.close(); }
  });

  await test('a saved language that does not exist (or an old settings value) falls back to "auto"', async () => {
    const { ctx, page } = await openHome(browser, { settings: { lang: 'klingon' }, query: '?xlang=fr' });
    try {
      eq((await st(page)).settings.lang, 'auto', 'sanitised setting');
      eq(await page.evaluate(() => window.__xod.lang()), 'fr', 'effective language');
    } finally { await ctx.close(); }
  });

  for (const width of [320, 412]) {
    await test(`texts fit on a ${width}px-wide phone: every status text, the panel and the settings sheet, in every language`, async () => {
      const { ctx, page, errors } = await openHome(browser, { mobile: true, viewport: { width, height: 700 } });
      try {
        await gotoEnd(page);
        for (const code of Object.keys(LOCALES)) {
          await page.evaluate((c) => window.__xod.set({ lang: c }), code);
          await sleep(120);
          // the panel
          const panel = await page.evaluate(() => {
            const g = document.getElementById('xod-gate').getBoundingClientRect();
            const more = document.getElementById('xod-more');
            const hint = document.querySelector('#xod-gate .xod-hint');
            const title = document.querySelector('#xod-gate .xod-title');
            return {
              inside: g.left >= 0 && g.right <= innerWidth, w: Math.round(g.width),
              moreClipped: more.scrollWidth > more.clientWidth + 1, hintClipped: hint.scrollWidth > hint.clientWidth + 1,
              titleClipped: title.scrollWidth > title.clientWidth + 1,
              pageScrollsSideways: document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert(panel.inside && !panel.moreClipped && !panel.hintClipped && !panel.titleClipped && !panel.pageScrollsSideways, `${code}: the panel does not fit at ${width}px: ${JSON.stringify(panel)}`);
          // the status chip in every state
          for (const state of ['starting', 'on', 'waiting', 'loading', 'off', 'failed', 'broken', 'silent']) {
            await page.evaluate((x) => window.__xod.previewChip(x), state);
            const chip = await page.evaluate(() => {
              const c = document.getElementById('xod-chip');
              c.style.visibility = 'visible';
              const r = c.getBoundingClientRect();
              const n = document.getElementById('xod-count');
              return { inside: r.left >= 0 && r.right <= innerWidth, clipped: n.scrollWidth > n.clientWidth + 1, w: Math.round(r.width) };
            });
            assert(chip.inside && !chip.clipped, `${code}/${state}: the status chip does not fit at ${width}px: ${JSON.stringify(chip)}`);
          }
          // the settings sheet
          await page.evaluate(() => document.getElementById('xod-sheet').classList.add('xod-open'));
          const sheet = await page.evaluate(() => {
            const r = document.getElementById('xod-sheet').getBoundingClientRect();
            const rows = [...document.querySelectorAll('#xod-sheet .xod-row, #xod-sheet .xod-foot')];
            return {
              inside: r.left >= -1 && r.right <= innerWidth + 1,
              rowsClipped: rows.some((e) => e.scrollWidth > e.clientWidth + 1),
              pageScrollsSideways: document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert(sheet.inside && !sheet.rowsClipped && !sheet.pageScrollsSideways, `${code}: the settings sheet does not fit at ${width}px: ${JSON.stringify(sheet)}`);
          await page.evaluate(() => document.getElementById('xod-sheet').classList.remove('xod-open'));
        }
        noErrors(errors);
      } finally { await ctx.close(); }
    });
  }

  await test('typing keys inside the extension\'s own widgets does not reach X\'s keyboard shortcuts', async () => {
    const { ctx, page } = await openHome(browser);
    try {
      await page.evaluate(() => { window.__keys = 0; document.addEventListener('keydown', () => { window.__keys++; }); });
      await page.click('#xod-gear');
      await page.focus('#xod-lang');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('j');
      await sleep(100);
      eq(await page.evaluate(() => window.__keys), 0, 'keydown events that reached the page');
    } finally { await ctx.close(); }
  });

  await test('diagnostics: shows hook status, counts and log; copies; holds no cursor, id or user data', async () => {
    const { ctx, page, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      await page.click('#xod-gate-settings');                      // the sheet opens over the panel
      await page.click('#xod-diag-box summary');
      await until(page, () => /HOLD/.test(document.getElementById('xod-diag').textContent), null, 4000);
      const text = await page.textContent('#xod-diag');
      for (const needle of [`OnDemand for X ${require('../package.json').version}`, 'hook: ready', 'via manifest', 'page structure: main=1/1 primaryColumn=1 tablists=[2/sel0]', 'HomeTimeline POST cursor=- ctx=launch -> pass:first', 'HOLD #', 'cursors: +', 'graphql operations seen: HomeTimeline×', 'UA:']) {
        assert(text.includes(needle), `diagnostics lack "${needle}":\n${text}`);
      }
      assert(!/AAAAAAAA/.test(text) && !/DAAC[BT]_Home/.test(text), `a full cursor leaked into the diagnostics:\n${text}`);
      assert(!/user\d|status\/|p100\d/.test(text), `post data leaked into the diagnostics:\n${text}`);

      // close the sheet, press the real button, then read the log again
      await page.click('#xod-close');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      await page.click('#xod-gear');
      await page.click('#xod-diag-refresh');
      await until(page, () => {
        const t = document.getElementById('xod-diag').textContent;
        return /RELEASE #/.test(t) && /DONE #\d+ ok=true status=200/.test(t);
      }, null, 4000);
      await page.click('#xod-diag-copy');
      await sleep(200);
      eq(await page.textContent('#xod-diag-copy'), 'Copied', 'copy button feedback');
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      assert(clip.includes('hook: ready'), 'clipboard does not hold the diagnostics');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('idle: no redraw loop once the page is quiet (battery); the only timer is a light check for navigation and dialogs', async () => {
    const { ctx, page } = await openHome(browser);
    try {
      await sleep(1200);
      const a = await page.evaluate(() => window.__xod.ticks());
      await sleep(3000);
      const b = await page.evaluate(() => window.__xod.ticks());
      assert(b - a <= 1, `${b - a} updates while nothing happens`);
    } finally { await ctx.close(); }
  });

  /* ───────── layout and real input ───────── */

  await test('wheel (desktop): scrolling to the end shows the panel, last post readable above it, scrolling back is never blocked', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await wheelDownUntilStuck(page);
      assert(await panelVisible(page), 'panel not shown');
      eq(cursorReqs(server).length, 0, 'requests');
      const geo = await page.evaluate(() => {
        const gate = document.getElementById('xod-gate').getBoundingClientRect();
        const arts = [...document.querySelectorAll('article[data-pid]')];
        const last = arts.map((a) => a.getBoundingClientRect()).sort((p, q) => q.bottom - p.bottom)[0];
        return { gateTop: gate.top, lastBottom: last.bottom, y: window.__pos() };
      });
      assert(geo.lastBottom <= geo.gateTop + 1, `the last post is hidden behind the panel (${geo.lastBottom} > ${geo.gateTop})`);
      await page.mouse.wheel(0, -1500);
      await sleep(400);
      assert((await page.evaluate(() => window.__pos())) < geo.y - 1000, 'scrolling up is blocked');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('panel look: the button is centred in the panel, white bold text, with room above it (the generic control reset must not win)', async () => {
    const { ctx, page } = await openHome(browser);
    try {
      await gotoEnd(page);
      await untilPanel(page, true);
      const g = await page.evaluate(() => {
        const btn = document.getElementById('xod-more');
        const gate = document.getElementById('xod-gate').getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        const cs = getComputedStyle(btn);
        const link = getComputedStyle(document.getElementById('xod-gate-settings'));
        return {
          color: cs.color, weight: Number(cs.fontWeight), size: cs.fontSize, marginTop: cs.marginTop,
          offCenter: Math.abs((b.left + b.right) / 2 - (gate.left + gate.right) / 2),
          linkSize: link.fontSize, linkMarginTop: link.marginTop,
        };
      });
      eq(g.color, 'rgb(255, 255, 255)', 'button text colour');
      assert(g.weight >= 700, `button text is not bold (${g.weight})`);
      eq(g.size, '15px', 'button font size');
      eq(g.marginTop, '12px', 'space above the button');
      assert(g.offCenter <= 1.5, `button is ${g.offCenter}px off the centre of the panel`);
      eq(g.linkSize, '12.5px', 'size of the settings link');
      eq(g.linkMarginTop, '8px', 'space above the settings link');
    } finally { await ctx.close(); }
  });

  await test('touch (mobile): swiping to the end shows the panel clear of X\'s bottom bar; the button works with a tap', async () => {
    const { ctx, page, server, errors } = await openHome(browser, { mobile: true });
    try {
      const cdp = await ctx.newCDPSession(page);
      await swipeUntilStuck(cdp, page);
      assert(await panelVisible(page), 'panel not shown');
      const geo = await page.evaluate(() => {
        const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
        const gate = document.getElementById('xod-gate').getBoundingClientRect();
        return { navTop: nav.top, gateBottom: gate.bottom, gateLeft: gate.left, gateRight: gate.right, vw: innerWidth };
      });
      assert(geo.gateBottom <= geo.navTop, `panel overlaps the nav bar (${geo.gateBottom} > ${geo.navTop})`);
      assert(geo.gateLeft >= 0 && geo.gateRight <= geo.vw, 'panel is wider than the screen');
      eq(cursorReqs(server).length, 0, 'requests while waiting');
      await page.tap('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).length, 1, 'requests after the tap');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('mobile: the status chip stays clear of the bottom bar and sits at the left of the feed', async () => {
    const { ctx, page } = await openHome(browser, { mobile: true });
    try {
      const geo = await page.evaluate(() => {
        const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
        const chip = document.getElementById('xod-chip').getBoundingClientRect();
        return { navTop: nav.top, chipBottom: chip.bottom, chipLeft: chip.left };
      });
      assert(geo.chipBottom <= geo.navTop, `chip overlaps the nav bar (${geo.chipBottom} > ${geo.navTop})`);
      assert(geo.chipLeft >= 0 && geo.chipLeft < 40, `chip is not at the left edge (${geo.chipLeft})`);
    } finally { await ctx.close(); }
  });

  await test('desktop: the chip sits on the feed column and never covers X\'s sidebar account button', async () => {
    const { ctx, page } = await openHome(browser);
    try {
      const geo = await page.evaluate(() => {
        const main = document.querySelector('main').getBoundingClientRect();
        const chip = document.getElementById('xod-chip').getBoundingClientRect();
        const acc = document.querySelector('.account').getBoundingClientRect();
        const overlap = !(chip.right < acc.left || chip.left > acc.right || chip.bottom < acc.top || chip.top > acc.bottom);
        return { mainLeft: main.left, mainRight: main.right, chipLeft: chip.left, chipRight: chip.right, overlap };
      });
      assert(geo.chipLeft >= geo.mainLeft && geo.chipRight <= geo.mainRight, 'chip is outside the feed column');
      assert(!geo.overlap, 'chip covers the sidebar account button');
    } finally { await ctx.close(); }
  });

  await test('Arabic interface (RTL layout): chip and panel stay on the feed column', async () => {
    const { ctx, page, errors } = await openHome(browser, { query: '?rtl=1' });
    try {
      await gotoEnd(page);
      assert(await panelVisible(page), 'panel not shown');
      const geo = await page.evaluate(() => {
        const m = document.querySelector('main').getBoundingClientRect();
        const c = document.getElementById('xod-chip').getBoundingClientRect();
        const g = document.getElementById('xod-gate').getBoundingClientRect();
        return { ml: m.left, mr: m.right, cl: c.left, cr: c.right, gl: g.left, gr: g.right };
      });
      assert(geo.cl >= geo.ml && geo.cr <= geo.mr, `chip outside the feed column: ${JSON.stringify(geo)}`);
      assert(geo.gl >= geo.ml - 1 && geo.gr <= geo.mr + 1, `panel outside the feed column: ${JSON.stringify(geo)}`);
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('leaving /home hides the extension\'s UI but keeps the parked page; coming back shows the panel again', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      assert(await panelVisible(page), 'panel before leaving');
      await page.evaluate(() => window.__mock.navigate('/someone/status/777'));
      await sleep(1000);
      eq(await page.evaluate(() => getComputedStyle(document.getElementById('xod-root')).display), 'none', 'UI on another page');
      eq((await st(page)).held.length, 1, 'still parked');
      eq(cursorReqs(server).length, 0, 'requests while away');
      await page.evaluate(() => window.__mock.navigate('/home'));
      await sleep(1000);
      assert(await panelVisible(page), 'panel after coming back');
      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40);
      eq(cursorReqs(server).length, 1, 'requests');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('a visible dialog (compose, image viewer) hides the extension\'s UI; a hidden one does not', async () => {
    const { ctx, page, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      assert(await panelVisible(page), 'panel before');
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'ghost';
        d.setAttribute('aria-modal', 'true');
        d.style.display = 'none';
        document.body.appendChild(d);
      });
      await sleep(900);
      assert(await panelVisible(page), 'a hidden aria-modal element must not hide the panel');
      await page.evaluate(() => document.getElementById('ghost').remove());
      await page.evaluate(() => { window.__dlg = window.__mock.openModal(); });
      await sleep(900);
      eq(await page.evaluate(() => getComputedStyle(document.getElementById('xod-root')).display), 'none', 'UI while a dialog is open');
      await page.evaluate(() => window.__dlg.remove());
      await sleep(900);
      assert(await panelVisible(page), 'panel after the dialog closed');
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('the panel waits for the real end of the posts: not shown while a screen or more of posts is still below it', async () => {
    const { ctx, page, server, errors } = await openHome(browser);
    try {
      // close enough for X to ask for the next page (it does so two screens before the end), but far from the end
      await page.evaluate(() => { scrollTo(0, window.__mock.info().total - 2.7 * innerHeight); });
      await until(page, () => window.__xod.state().held.length === 1);
      await sleep(500);
      assert(!(await panelVisible(page)), 'the panel is up while about two screens of posts are still below');
      eq(cursorReqs(server).length, 0, 'requests');
      await gotoEnd(page);
      await untilPanel(page, true);
      assert(await lastPostClearOfPanel(page), 'the last post is covered by the panel');
      // scrolling back up (more than the hide distance) takes the panel away again
      await page.evaluate(() => { scrollTo(0, window.scrollY - 1200); });
      await untilPanel(page, false);
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  await test('while waiting, the room below the posts follows the end of the posts when they grow with no scrolling at all (an image finishes loading)', async () => {
    const { ctx, page, errors } = await openHome(browser);
    try {
      await gotoEnd(page);
      await untilPanel(page, true);
      await sleep(400);
      const read = () => page.evaluate(() => {
        const sp = document.getElementById('xod-spacer');
        const l = document.getElementById('list');
        return { top: parseFloat(sp.style.top), end: l.getBoundingClientRect().bottom + window.scrollY };
      });
      const before = await read();
      assert(Math.abs(before.top - before.end) <= 2, `the room is ${Math.abs(before.top - before.end)}px away from the end before the growth`);
      await page.evaluate(() => window.__mock.lateGrow(120));
      await sleep(400);                                          // no scroll, no request, nothing else happens
      const after = await read();
      assert(after.end - before.end >= 100, `the mock did not grow (${before.end} -> ${after.end})`);
      assert(Math.abs(after.top - after.end) <= 2, `the room did not follow the end: room ${after.top}, end ${after.end}`);
      noErrors(errors);
    } finally { await ctx.close(); }
  });

  const variants = [
    ['an inner element scrolls instead of the window', '?scroller=inner', (s) => assert(s.scrollerIsInner, 'inner scroller was not detected')],
    ['markup without data-testid="cellInnerDiv"', '?nocell=1'],
    ['no virtualisation (normal document flow)', '?mode=flow'],
    ['X unmounts aggressively (no buffer)', '?buf=0'],
    ['posts grow after mounting (images loading)', '?jitter=1'],
    ['the app root has the height of the window and the posts overflow it (like X\'s markup)', '?rootfixed=1', (s, page) => page.evaluate(() => {
      const root = document.getElementById('react-root').getBoundingClientRect();
      if (root.height > innerHeight + 2) throw new Error('the variant is not what it should be: the root grew with its content');
    })],
  ];
  for (const [name, query, extra] of variants) {
    await test(`variant: ${name}`, async () => {
      const { ctx, page, server, errors } = await openHome(browser, { query });
      try {
        await gotoEnd(page);
        const s = await st(page);
        eq(s.held.length, 1, 'parked');
        assert(await panelVisible(page), 'panel not shown');
        eq(cursorReqs(server).length, 0, 'requests while waiting');
        if (extra) await extra(s, page);
        if (!/scroller=inner/.test(query)) {
          await gotoEnd(page, { wait: 400 });                   // the reader keeps scrolling (posts may have grown meanwhile)
          assert(await lastPostClearOfPanel(page), 'the last post is covered by the panel');
        }
        await page.click('#xod-more');
        await until(page, () => window.__mock.info().items >= 40);
        eq(cursorReqs(server).length, 1, 'requests after the press');
        noErrors(errors);
      } finally { await ctx.close(); }
    });
  }

  await browser.close();

  /* ───────── the packaged extension, loaded into real Chromium, on a page with a strict CSP ───────── */

  // like X: scripts only with the page's own nonce or from X's CDN; nothing from chrome-extension://
  const STRICT_CSP = "script-src 'nonce-xodTest' https://abs.twimg.com; object-src 'none'; base-uri 'self'";

  // reads the diagnostics text from the settings sheet of a packaged build (it has no test hooks)
  async function packagedDiag(page) {
    // while the "batch finished" panel is up the chip is hidden and the panel has its own settings link
    const viaPanel = await page.evaluate(() => document.getElementById('xod-gate').classList.contains('xod-on'));
    await page.click(viaPanel ? '#xod-gate-settings' : '#xod-gear');
    await page.evaluate(() => { document.getElementById('xod-diag-box').open = true; });
    await page.waitForFunction(() => /hook: ready/.test(document.getElementById('xod-diag').textContent), null, { timeout: 5000 });
    await sleep(300);
    const text = await page.textContent('#xod-diag');
    await page.click('#xod-close');
    return text;
  }

  // full = also checks the settings (shared with other tabs, saved for new tabs)
  async function packagedRun(extDir, { full, via, injected }) {
    assert(fs.existsSync(path.join(extDir, 'manifest.json')), `${extDir}: run \`node tools/build.js\` first`);
    for (const f of ['hook.js', 'content.js', 'i18n.js', 'content.css']) assert(fs.existsSync(path.join(extDir, f)), `${f} is not in the package`);
    assert(!fs.readFileSync(path.join(extDir, 'content.js'), 'utf8').includes('__XOD_TEST__'), 'test hooks were not stripped from the shipped build');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xod-profile-'));
    const ctx = await chromium.launchPersistentContext(userData, {
      executablePath: CHROME,
      headless: true,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--no-sandbox', '--disable-smooth-scrolling', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
        ...(process.env.XOD_CHROME_ARGS ? process.env.XOD_CHROME_ARGS.split(' ') : [])],
    });
    try {
      const server = makeServer();
      await routeMock(ctx, server, { csp: STRICT_CSP });
      const page = ctx.pages()[0] || (await ctx.newPage());
      const errors = watchErrors(page);
      const violations = [];
      page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
      await page.goto('https://x.com/home?xlang=en', { waitUntil: 'load' });
      await page.waitForSelector('#xod-chip', { timeout: 10000, state: 'attached' });
      await until(page, () => document.getElementById('xod-chip').dataset.state === 'on', null, 10000);

      // the end of the batch: parked, the server is not asked
      await until(page, () => window.__mock.info().items >= 20, null, 6000);
      for (let k = 0; k < 3; k++) { await page.evaluate(() => window.__mock.scrollToEnd()); await sleep(150); }
      await until(page, () => document.getElementById('xod-chip').dataset.state === 'waiting' || document.getElementById('xod-gate').classList.contains('xod-on'), null, 6000);
      await sleep(800);
      eq(cursorReqs(server).length, 0, 'next-page requests that reached the server');
      assert(await panelVisible(page), 'panel not shown by the packaged extension');

      const diag = await packagedDiag(page);
      assert(diag.includes(`via ${via}`), `the hook should have come in via "${via}":\n${diag.split('\n').slice(0, 5).join('\n')}`);
      assert(diag.includes(`injected: ${injected}`), `injected should be ${injected}:\n${diag.split('\n').slice(0, 5).join('\n')}`);
      assert(/page structure: main=1\/1 primaryColumn=1 tablists=\[2\/sel0\]/.test(diag), 'the diagnostics should describe the page structure');

      await page.click('#xod-more');
      await until(page, () => window.__mock.info().items >= 40, null, 6000);
      eq(cursorReqs(server).length, 1, 'requests after the press');

      if (full) {
        // a second tab, opened BEFORE the settings change, must follow it live
        const early = await ctx.newPage();
        await early.goto('https://x.com/home?xlang=en', { waitUntil: 'load' });
        await early.waitForSelector('#xod-chip', { timeout: 10000, state: 'attached' });
        await until(early, () => document.getElementById('xod-chip').dataset.state === 'on', null, 10000);
        await page.bringToFront();

        // settings go to chrome.storage.local (not to the page's localStorage) and reach the other tab
        await page.click('#xod-gear');
        await page.click('#xod-switch');
        await sleep(500);
        eq(await page.evaluate(() => localStorage.getItem('xod-settings')), null, 'the page storage must stay untouched');
        eq(await early.getAttribute('#xod-chip', 'data-state'), 'off', 'an already-open tab did not follow the settings change');
        await early.bringToFront();
        for (let k = 0; k < 4; k++) { await early.evaluate(() => window.__mock.scrollToEnd()); await sleep(350); }
        assert(cursorReqs(server).length >= 2, 'with the extension off the other tab should load pages freely');

        // a brand-new tab: the saved choice comes back from chrome.storage.local
        const page2 = await ctx.newPage();
        await page2.goto('https://x.com/home?xlang=en', { waitUntil: 'load' });
        await page2.waitForSelector('#xod-chip', { timeout: 10000, state: 'attached' });
        await sleep(500);
        eq(await page2.getAttribute('#xod-chip', 'data-state'), 'off', 'saved choice not restored from extension storage');

        // the language picker works in the shipped build, every language under its own name
        await page2.click('#xod-gear');
        const options = await page2.evaluate(() => [...document.querySelectorAll('#xod-lang option')].map((o) => o.textContent));
        eq(options, ['Auto', ...Object.keys(LOCALES).map((c) => LOCALES[c]._name)], 'language picker in the shipped build');
        await page2.selectOption('#xod-lang', 'tr');
        await sleep(200);
        eq(await page2.getAttribute('#xod-root', 'dir'), 'ltr', 'Turkish direction');
        eq(await page2.textContent('#xod-sheet .xod-h'), LOCALES.tr.title, 'Turkish settings title');
        await page2.selectOption('#xod-lang', 'ar');
        await sleep(200);
        eq(await page2.getAttribute('#xod-root', 'dir'), 'rtl', 'Arabic direction');
      }

      eq(violations, [], 'Content-Security-Policy violations');
      noErrors(errors);
    } finally {
      await ctx.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  }

  const tmpCopy = (from) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xod-pkg-'));
    fs.cpSync(from, dir, { recursive: true });
    return dir;
  };
  const DIST = path.join(ROOT, 'dist');
  const CHROMIUM_DIR = process.env.XOD_EXT_DIR || path.join(DIST, 'chromium');
  const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

  await test('PACKAGED chromium build under a strict CSP: the hook comes from the manifest, next page parked, button releases, settings shared, languages work', async () => {
    await packagedRun(CHROMIUM_DIR, { full: true, via: 'manifest', injected: false });
  });

  await test('PACKAGED chromium zip (the file that is shipped): unpacked and run, same behaviour', async () => {
    const zip = path.join(DIST, `ondemand-for-x-${VERSION}-chromium.zip`);
    assert(fs.existsSync(zip), 'run `node tools/build.js` first');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xod-zip-'));
    try {
      require('child_process').execFileSync('unzip', ['-q', zip, '-d', dir]);
      assert(fs.existsSync(path.join(dir, 'manifest.json')), 'manifest.json must be at the root of the zip');
      await packagedRun(dir, { full: false, via: 'manifest', injected: false });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('PACKAGED fallback: a browser that ignores "world": "MAIN" (the hook runs in the extension\'s world, does nothing) gets the same file as a <script> tag and works', async () => {
    const dir = tmpCopy(path.join(DIST, 'chromium'));
    try {
      const mf = path.join(dir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      let n = 0;
      for (const cs of m.content_scripts) if (cs.world) { delete cs.world; n++; }
      eq(n, 1, 'page-world entries removed from the copy');
      fs.writeFileSync(mf, JSON.stringify(m));
      await packagedRun(dir, { full: false, via: 'script tag', injected: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('PACKAGED firefox build, loaded in Chromium (checks its files and the shared logic, NOT Firefox itself): same behaviour', async () => {
    const dir = path.join(DIST, 'firefox');
    assert(fs.existsSync(path.join(dir, 'manifest.json')), 'run `node tools/build.js` first');
    await packagedRun(dir, { full: false, via: 'manifest', injected: false });
  });

  /* ───────────────────────────── summary ───────────────────────────── */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

// `node test/run-tests.cjs` runs the suite; other scripts (tools/screenshots.cjs) can require() the helpers
if (require.main === module) main().catch((e) => { console.error('RUNNER CRASHED', e); process.exit(2); });
module.exports = { chromium, CHROME, openHome, gotoEnd, sleep, panelVisible, until, st };
