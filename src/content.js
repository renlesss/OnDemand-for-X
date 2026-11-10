/*
 * OnDemand for X — content script (extension side)
 *
 * X's Home feed asks the server for the next page of posts by itself as you scroll.
 * This extension parks that one request (see hook.js, which runs inside X's page)
 * until you press "load a new batch". Until then X's server is never asked, so no
 * posts are sent to you that you did not ask for. Nothing is hidden.
 *
 * This file is the extension's side: it injects hook.js, keeps the settings, shows
 * the small status chip, the "batch finished" panel with its button, and a
 * diagnostics screen. It makes no network requests and sends no data anywhere.
 *
 * Works as a Manifest V3 or V2 content script (run_at: document_start).
 * Every failure path fails OPEN: if anything is wrong, X behaves as if the
 * extension were not installed.
 */
(() => {
  'use strict';

  if (window.__xodBooted) return;
  window.__xodBooted = true;

  /* ────────────────────────── configuration ────────────────────────── */

  const VERSION = '0.9.1';
  const STORAGE_KEY = 'xod-settings';
  const DEFAULTS = { enabled: true, lang: 'auto' };
  const CH = 'xod-1';                       // message channel shared with hook.js
  const HOOK_FILE = 'hook.js';

  const ROUTE_POLL_MS = 400;                 // SPA route changes / late mounting are detected by polling
  const SCROLL_THROTTLE_MS = 60;
  const SHOW_PANEL_WITHIN_PX = 320;          // show the panel when the end of the posts is this close
  const HIDE_PANEL_BEYOND_PX = 520;          // hide it again when the end is this far away
  const HOOK_FALLBACK_MS = 400;              // the manifest's page-world copy of the hook answers at once; if not, add it as a <script> tag
  let HOOK_GRACE_MS = 4000;                  // the hook must answer within this time
  let MAIN_MISSING_MS = 6000;                // parked request but no page structure to attach the interface to: let X load it
  let SILENT_AFTER_MS = 15000;               // on /home with no timeline request seen at all after this long: warn
  const FAIL_NOTICE_MS = 12000;
  const PRESS_TIMEOUT_MS = 6000;             // the button is usable again if the hook never answers a press

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // The texts live in locales/*.json. tools/build.js turns them into i18n.js, which the manifest loads before this file.
  const I18N = (typeof globalThis !== 'undefined' && globalThis.__xodI18n) || { order: ['en'], names: { en: 'English' }, t: { en: { dir: 'ltr' } } };
  const LANGS = I18N.order;
  const TABLE = {};
  for (const code of LANGS) TABLE[code] = Object.assign({}, I18N.t.en || {}, I18N.t[code]);   // a missing text falls back to English

  const DEBUG = (() => {
    try { return localStorage.getItem('xod-debug') === '1'; } catch (e) { return false; }
  })();
  const log = (...args) => { if (DEBUG) console.debug('[xod]', ...args); };

  /* ───────────────────────────── state ───────────────────────────── */

  let settings = { ...DEFAULTS };
  const hook = {
    ready: false,
    failed: false,          // the hook script could not be loaded into the page
    injected: false,        // this script added hook.js to the page as a <script> tag (the manifest's own copy did not answer)
    via: '',                // how the running hook reached the page, as the hook itself reports it
    held: [],               // parked requests, as reported by the hook
    inflight: 0,            // released requests that have not finished yet
    stats: null,
    log: null,              // last diagnostics snapshot
    lastFail: 0,
    t0: Date.now(),
  };
  let ui = null;
  let scroller = null;       // null = the window scrolls; otherwise an inner element
  let panelOn = false;
  let pressed = false;       // the button was pressed, the hook has not answered yet
  let relSeq = 0;            // number of release commands sent; the hook echoes the last one it handled
  let lastRoute = location.pathname;
  let lastModal = false;
  let homeSince = 0;
  let booted = false;
  let tickTimer = 0;
  let tickCount = 0;
  let mainMissingSince = 0;  // on /home without the page structure the interface attaches to
  let failOpen = false;      // the hook was told to let everything through because the interface cannot be shown
  const seenAt = new Map();  // parked request id -> index of the tab that was selected when the interface first saw it

  /* ───────────────────────────── helpers ───────────────────────────── */

  const isHome = () => (location.pathname.replace(/\/+$/, '') || '/') === '/home';

  // A language tag as X or the browser writes it ("pt-PT", "zh-Hant", "ar-SA", "in") -> one of our codes, or ''.
  function matchLang(tag) {
    const t = String(tag || '').toLowerCase().replace(/_/g, '-');
    if (!t) return '';
    const exact = LANGS.find((c) => c.toLowerCase() === t);
    if (exact) return exact;
    const parts = t.split('-');
    const primary = parts[0] === 'in' ? 'id' : parts[0];                     // "in" is the old code of Indonesian
    if (primary === 'zh') {                                                    // Traditional for Taiwan, Hong Kong, Macau or "Hant", else Simplified
      const code = parts.some((x) => x === 'tw' || x === 'hk' || x === 'mo' || x === 'hant') ? 'zh-TW' : 'zh-CN';
      return LANGS.includes(code) ? code : '';
    }
    return LANGS.find((c) => c.toLowerCase() === primary) || LANGS.find((c) => c.toLowerCase().split('-')[0] === primary) || '';
  }

  // "auto": the language X itself is shown in, else the browser's languages in their order, else English
  function lang() {
    if (LANGS.includes(settings.lang)) return settings.lang;
    const wanted = [document.documentElement.getAttribute('lang') || ''].concat(Array.from(navigator.languages || []), [navigator.language || '']);
    for (const w of wanted) {
      const code = matchLang(w);
      if (code) return code;
    }
    return 'en';
  }
  const T = () => TABLE[lang()] || TABLE.en || {};

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) for (const k of Object.keys(props)) node.setAttribute(k, props[k]);
    for (const kid of kids) node.append(kid);
    return node;
  }

  function svg(tag, props, ...kids) {
    const node = document.createElementNS(SVG_NS, tag);
    if (props) for (const k of Object.keys(props)) node.setAttribute(k, props[k]);
    for (const kid of kids) node.append(kid);
    return node;
  }

  // a small "sliders" icon, drawn instead of an emoji so it looks the same everywhere
  function slidersIcon() {
    const line = (y) => svg('line', { x1: '4', y1: String(y), x2: '20', y2: String(y) });
    const knob = (cx, cy) => svg('circle', { cx: String(cx), cy: String(cy), r: '2.3', class: 'xod-knob' });
    return svg('svg', {
      viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true', focusable: 'false',
    }, line(7), line(12), line(17), knob(9, 7), knob(15, 12), knob(8, 17));
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  /* ───────────────────────────── settings ───────────────────────────── */

  function sanitize(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: s.enabled === undefined ? DEFAULTS.enabled : !!s.enabled,
      lang: s.lang === 'auto' || LANGS.includes(s.lang) ? s.lang : DEFAULTS.lang,
    };
  }

  function hasExtStorage() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
    } catch (e) { return false; }
  }

  function loadSettings(cb) {
    if (hasExtStorage()) {
      try {
        chrome.storage.local.get(STORAGE_KEY, (res) => {
          let v = null;
          try { v = res && res[STORAGE_KEY]; } catch (e) { /* ignore */ }
          cb(sanitize(v));
        });
        return;
      } catch (e) { /* fall through to localStorage */ }
    }
    try { cb(sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'))); } catch (e) { cb(sanitize(null)); }
  }

  function persistSettings() {
    if (hasExtStorage()) {
      try { chrome.storage.local.set({ [STORAGE_KEY]: { ...settings } }); return; } catch (e) { /* fall through */ }
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  function applySettings(next, persist) {
    const prev = settings;
    settings = next;
    if (persist) persistSettings();
    if (prev.enabled !== next.enabled) sendConfig();
    renderUI();
    scheduleTick();
  }

  /* ───────────────────────────── talking to the hook ───────────────────────────── */

  function toHook(msg) {
    try {
      window.postMessage({ __xod: CH, from: 'ui', ...msg }, location.origin);
    } catch (e) { /* ignore */ }
  }

  function sendConfig() {
    toHook({ type: 'config', enabled: settings.enabled && !failOpen });
  }

  function requestLog() {
    toHook({ type: 'getlog' });
  }

  // For each parked request: which tab was selected when the interface first heard of it. A request is parked because
  // X asked for the next page of the feed that is on screen, so this says which tab it belongs to, whatever the tab
  // strip's order is (see waitingEntries).
  function noteHeld() {
    const f = tabNow();
    const alive = new Set();
    for (const e of hook.held) {
      alive.add(e.id);
      if (!seenAt.has(e.id)) seenAt.set(e.id, f ? f.i : null);
    }
    for (const id of Array.from(seenAt.keys())) if (!alive.has(id)) seenAt.delete(id);
  }

  function onMessage(ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__xod !== CH || d.from !== 'hook') return;
    if (d.type === 'ping') {                      // the hook asks whether anybody can still press the button: yes, at once
      toHook({ type: 'pong' });
      return;
    }
    if (d.type === 'ready') {
      hook.ready = true;
      if (typeof d.via === 'string') hook.via = d.via;
      sendConfig();
    } else if (d.type === 'state') {
      hook.ready = true;
      hook.held = Array.isArray(d.held) ? d.held.filter((e) => e && typeof e === 'object').slice(0, 50) : [];
      noteHeld();
      hook.inflight = Number(d.inflight) || 0;
      hook.stats = d.stats && typeof d.stats === 'object' ? d.stats : hook.stats;
      if ((Number(d.ack) || 0) >= relSeq) pressed = false;
      if (d.gone === true) sendConfig();          // the hook let everything through because it heard nothing from us: say that we are here
    } else if (d.type === 'done') {
      if (d.ok === false) hook.lastFail = Date.now();
      setTimeout(scheduleTick, FAIL_NOTICE_MS + 60);
    } else if (d.type === 'log') {
      hook.log = d;
      renderDiag();
    }
    scheduleTick(0);
  }

  // The hook has to run in X's own page. The manifest asks the browser to do that (a content script of the page's world,
  // which no page policy can block and which is in place before X's first script). This is the fallback for browsers that
  // ignore that setting: the same file, added to the page as a <script> tag.
  function injectHook() {
    if (!hasExtStorage()) return;                 // not running as an extension (e.g. a test page loads the hook itself)
    if (hook.injected || hook.ready) return;
    try {
      const parent = document.head || document.documentElement;
      if (!parent) {                                // (not expected at document_start) try again once the parser made one
        document.addEventListener('readystatechange', injectHook, { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL(HOOK_FILE);
      s.onload = () => s.remove();
      s.onerror = () => { hook.failed = true; s.remove(); scheduleTick(); };
      parent.appendChild(s);
      hook.injected = true;
    } catch (e) {
      hook.failed = true;
    }
  }

  // ask the hook to introduce itself a few times (it may have started before we listened)
  function sayHello() {
    let n = 0;
    const timer = setInterval(() => {
      if (hook.ready || ++n > 16) { clearInterval(timer); return; }
      toHook({ type: 'hello' });
    }, 250);
    toHook({ type: 'hello' });
  }

  /* ───────────────────────── scrolling abstraction ───────────────────────── */

  const rootEl = () => document.scrollingElement || document.documentElement;

  function scrollTop() {
    return scroller ? scroller.scrollTop : (window.scrollY || rootEl().scrollTop || 0);
  }
  function viewportH() {
    return scroller ? scroller.clientHeight : (window.innerHeight || rootEl().clientHeight);
  }

  // Does the window itself scroll (the normal case on X)? An element that is taller
  // than the screen is not enough: html/body can be overflow:hidden, with an inner
  // element doing the scrolling.
  function windowScrolls() {
    let overflow = getComputedStyle(document.documentElement).overflowY;
    if (overflow === 'visible' && document.body) overflow = getComputedStyle(document.body).overflowY;
    if (overflow === 'hidden' || overflow === 'clip') return false;
    const root = rootEl();
    return root.scrollHeight > root.clientHeight + 4;
  }

  function pickScroller(ref) {
    if (windowScrolls()) { scroller = null; return; }
    if (scroller && scroller.isConnected && scroller.scrollHeight > scroller.clientHeight + 4) return;
    scroller = null;
    let p = ref && ref.parentElement;
    while (p) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight + 4) {
        scroller = p;
        return;
      }
      if (p === document.documentElement) break;
      p = p.parentElement;
    }
  }

  // Where do the loaded posts end? X lays the posts out as cells of one container (a virtual list: only
  // some cells are really in the page, but the container is as tall as all of them). The bottom edge of
  // that container is the end of the posts, wherever the rest of the page happens to end.
  // Returns { bottom (a viewport coordinate), box (the container) }, or null when no cells are found.
  function postsEnd(main) {
    const col = (main && main.querySelector('[data-testid="primaryColumn"]')) || main;
    if (!col) return null;
    const cells = col.querySelectorAll('[data-testid="cellInnerDiv"]');
    if (!cells.length) return null;
    const last = cells[cells.length - 1];
    let box = cells[0].parentElement;
    while (box && box !== col && !box.contains(last)) box = box.parentElement;
    if (box === col) box = null;
    let bottom = -Infinity;
    for (const c of cells) bottom = Math.max(bottom, c.getBoundingClientRect().bottom);
    if (box) bottom = Math.max(bottom, box.getBoundingClientRect().bottom);
    return { bottom, box };
  }

  // the height of the scrollable page without the room we add ourselves (used when the cells are not found)
  function pageEnd() {
    const sp = ui && ui.spacer;
    if (!sp || !sp.classList.contains('xod-on')) return rootEl().scrollHeight;
    sp.style.display = 'none';
    const h = rootEl().scrollHeight;
    sp.style.display = '';
    return h;
  }

  // distance between the bottom of the screen and the end of the loaded posts
  function distanceToEnd(end) {
    const vh = viewportH();
    if (scroller) return scroller.scrollHeight - (scroller.scrollTop + vh);
    if (end) return end.bottom - vh;
    return pageEnd() - (scrollTop() + vh);
  }

  function modalOpen() {
    for (const el of document.querySelectorAll('[aria-modal="true"]')) {
      if (el.getClientRects().length) return true;
    }
    return false;
  }

  /* ───────────────────────────── which timeline? ───────────────────────────── */

  // "For you" is X's HomeTimeline, "Following" is HomeLatestTimeline. The tab strip tells which is on screen.
  // null = cannot tell (then any parked request counts); 'other' = a pinned list or any further tab, which this
  // extension does not touch (nothing is parked for it, so no panel).
  function findMain() {
    return document.querySelector('main[role="main"]') || document.querySelector('main') || document.querySelector('[data-testid="primaryColumn"]');
  }

  function pickTabs(lists) {
    for (const list of lists) {
      const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
      if (tabs.length < 2) continue;
      const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
      if (i >= 0) return { n: tabs.length, i };
    }
    return null;
  }

  function findTabs() {
    const scopes = [
      document.querySelector('main[role="main"] [data-testid="primaryColumn"]'),
      document.querySelector('[data-testid="primaryColumn"]'),
      document.querySelector('main[role="main"]') || document.querySelector('main'),
    ];
    for (const scope of scopes) {
      if (!scope) continue;
      const r = pickTabs(scope.querySelectorAll('[role="tablist"]'));
      if (r) return { ...r, sure: true };
    }
    const r = pickTabs(document.querySelectorAll('[role="tablist"]'));      // markup we do not know: any tab strip on the page
    return r ? { ...r, sure: false } : null;
  }

  function tabNow() {
    try { return findTabs(); } catch (e) { return null; }
  }

  function activeOp() {
    const f = tabNow();
    if (!f) return null;
    if (f.i === 0) return 'HomeTimeline';
    if (f.i === 1) return 'HomeLatestTimeline';
    return f.sure ? 'other' : null;
  }

  // The parked requests that belong to the timeline on screen.
  function waitingEntries() {
    const op = activeOp();
    if (op === 'other') return [];
    const same = hook.held.filter((e) => !op || e.op === op);
    if (same.length || !op) return same;
    // The tab strip names one timeline, but X parked a request for the other one while this very tab was selected: the
    // order of the tabs is not what we assume (X changed it). Trust what X did, not what the strip suggests, so that a
    // parked request is never left without a button. (A tab we could not read when the request appeared counts too.)
    const f = tabNow();
    return f ? hook.held.filter((e) => { const at = seenAt.get(e.id); return at == null || at === f.i; }) : [];
  }

  const waitingCount = () => waitingEntries().length;

  // which timeline the button serves (null: the newest parked request, whichever timeline it is for)
  function releaseOp() {
    const op = activeOp();
    if (op === 'other') return null;
    if (op && !hook.held.some((e) => e.op === op)) {          // the case described in waitingEntries
      const list = waitingEntries();
      if (list.length) return list[list.length - 1].op;
    }
    return op;
  }

  function chipState() {
    if (!settings.enabled) return 'off';
    if (hook.failed || (!hook.ready && Date.now() - hook.t0 > HOOK_GRACE_MS)) return 'broken';
    if (!hook.ready) return 'starting';
    if (hook.inflight > 0 || pressed) return 'loading';
    if (Date.now() - hook.lastFail < FAIL_NOTICE_MS) return 'failed';
    if (waitingCount() > 0) return 'waiting';
    const s = hook.stats;
    if (s && homeSince && s.seen === 0 && s.late === 0 && Date.now() - homeSince > SILENT_AFTER_MS) return 'silent';
    return 'on';
  }

  /* ───────────────────────────── the panel ───────────────────────────── */

  function setPanel(on) {
    panelOn = on;
    if (!ui) return;
    ui.gate.classList.toggle('xod-on', on);
    ui.root.classList.toggle('xod-gating', on);       // the panel has its own settings link: hide the chip
  }

  // While a page is waiting, the container of the posts is watched: when it changes size (images
  // loading, X re-measuring posts) the end moves, and the room below it has to follow.
  let listWatch = null;
  function watchList(box) {
    if (listWatch && listWatch.box === box) return;
    unwatchList();
    if (!box || typeof ResizeObserver !== 'function') return;
    try {
      const ro = new ResizeObserver(() => scheduleTick());
      ro.observe(box);
      listWatch = { box, ro };
    } catch (e) { listWatch = null; }
  }
  function unwatchList() {
    if (!listWatch) return;
    try { listWatch.ro.disconnect(); } catch (e) { /* ignore */ }
    listWatch = null;
  }

  // Keeps the page scrollable far enough to bring the last post above the panel. The spacer is positioned
  // (absolutely, in document coordinates) right at the end of the posts, so it works however X's page is
  // built around the list.
  function setSpacer(on, end) {
    if (!ui) return;
    ui.spacer.classList.toggle('xod-on', on);
    if (!on) { unwatchList(); return; }
    if (scroller) return;
    watchList(end && end.box);
    const y = end ? end.bottom + scrollTop() : pageEnd();
    const top = `${Math.max(0, Math.round(y))}px`;
    if (ui.spacer.style.top !== top) ui.spacer.style.top = top;
  }

  function updatePanel(main) {
    const want = settings.enabled && hook.ready && (waitingCount() > 0 || hook.inflight > 0 || pressed);
    if (!want) { setSpacer(false); setPanel(false); return; }
    const end = scroller ? null : postsEnd(main);
    setSpacer(true, end);
    const dist = distanceToEnd(end);
    setPanel(panelOn ? dist < HIDE_PANEL_BEYOND_PX : dist < SHOW_PANEL_WITHIN_PX);
  }

  function releaseNow() {
    if (pressed || hook.inflight > 0) return;
    pressed = true;
    const mine = ++relSeq;
    toHook({ type: 'release', op: releaseOp(), seq: mine });
    setTimeout(() => { if (pressed && relSeq === mine) { pressed = false; scheduleTick(); } }, PRESS_TIMEOUT_MS);   // the hook never answered
    renderPanel();
    renderChip();
  }

  /* ───────────────────────────── interface ───────────────────────────── */

  function buildUI() {
    const root = h('div', { id: 'xod-root' });

    const gear = h('button', { id: 'xod-gear', type: 'button' }, slidersIcon());
    const status = h('span', { id: 'xod-count' });
    const chip = h('div', { id: 'xod-chip' }, gear, status);

    const gTitle = h('div', { class: 'xod-title' });
    const gHint = h('div', { class: 'xod-hint' });
    const more = h('button', { id: 'xod-more', type: 'button' });
    const gSettings = h('button', { id: 'xod-gate-settings', type: 'button' });
    const gate = h('div', { id: 'xod-gate', role: 'region' }, gTitle, gHint, more, gSettings);

    const sTitle = h('div', { class: 'xod-h' });
    const close = h('button', { id: 'xod-close', type: 'button' }, '×');
    const sw = h('button', { id: 'xod-switch', type: 'button', role: 'switch' });
    const swLabel = h('span', { class: 'xod-label' });
    const langLabel = h('span', { class: 'xod-label' });
    const langSel = h('select', { id: 'xod-lang' },
      h('option', { value: 'auto' }), ...LANGS.map((c) => h('option', { value: c }, I18N.names[c] || c)));   // each language under its own name

    const diagBox = h('details', { id: 'xod-diag-box' });
    const diagSum = h('summary');
    const diagHint = h('div', { class: 'xod-foot' });
    const diagPre = h('pre', { id: 'xod-diag' });
    const diagRefresh = h('button', { id: 'xod-diag-refresh', type: 'button' });
    const diagCopy = h('button', { id: 'xod-diag-copy', type: 'button' });
    diagBox.append(diagSum, diagHint, diagPre, h('div', { class: 'xod-diagbtns' }, diagRefresh, diagCopy));

    const foot = h('div', { class: 'xod-foot' });
    const sheet = h('div', { id: 'xod-sheet', role: 'dialog' },
      h('div', { class: 'xod-row xod-head' }, sTitle, close),
      h('div', { class: 'xod-row' }, swLabel, sw),
      h('div', { class: 'xod-row' }, langLabel, langSel),
      diagBox,
      foot);
    const backdrop = h('div', { id: 'xod-backdrop' });
    const spacer = h('div', { id: 'xod-spacer', 'aria-hidden': 'true' });

    root.append(chip, gate, backdrop, sheet, spacer);

    const openSheet = () => { sheet.classList.add('xod-open'); backdrop.classList.add('xod-open'); renderUI(); };
    const closeSheet = () => { sheet.classList.remove('xod-open'); backdrop.classList.remove('xod-open'); };
    gear.addEventListener('click', () => (sheet.classList.contains('xod-open') ? closeSheet() : openSheet()));
    gSettings.addEventListener('click', openSheet);
    close.addEventListener('click', closeSheet);
    backdrop.addEventListener('click', closeSheet);
    more.addEventListener('click', releaseNow);
    sw.addEventListener('click', () => applySettings({ ...settings, enabled: !settings.enabled }, true));
    langSel.addEventListener('change', () => applySettings({ ...settings, lang: langSel.value }, true));
    diagBox.addEventListener('toggle', () => { if (diagBox.open) { requestLog(); renderDiag(); } });
    diagRefresh.addEventListener('click', () => { requestLog(); renderDiag(); });
    diagCopy.addEventListener('click', () => copyDiag());
    // keep typing in our fields away from X's keyboard shortcuts
    root.addEventListener('keydown', (e) => e.stopPropagation());

    return {
      root, chip, gear, status, gate, gTitle, gHint, more, gSettings,
      sheet, backdrop, sTitle, close, sw, swLabel, langLabel, langSel,
      diagBox, diagSum, diagHint, diagPre, diagRefresh, diagCopy, foot, spacer,
    };
  }

  function ensureUI() {
    if (ui && ui.root.isConnected) return;
    if (!ui) ui = buildUI();
    (document.body || document.documentElement).appendChild(ui.root);
    renderUI();
  }

  function showUI(on) {
    if (!ui) return;
    const want = on ? '' : 'none';
    if (ui.root.style.display !== want) ui.root.style.display = want;
  }

  function renderUI() {
    if (!ui) return;
    const tx = T();
    ui.root.setAttribute('dir', tx.dir);
    ui.root.setAttribute('lang', lang());
    ui.gear.setAttribute('aria-label', tx.settings);
    ui.gear.title = tx.settings;
    ui.gate.setAttribute('aria-label', tx.gateTitle);
    setText(ui.gTitle, tx.gateTitle);
    setText(ui.gHint, tx.gateHint);
    setText(ui.gSettings, tx.settings);
    setText(ui.sTitle, tx.title);
    ui.close.setAttribute('aria-label', tx.close);
    setText(ui.swLabel, tx.enabled);
    ui.sw.setAttribute('aria-checked', settings.enabled ? 'true' : 'false');
    ui.sw.setAttribute('aria-label', tx.enabled);
    setText(ui.langLabel, tx.language);
    setText(ui.langSel.firstElementChild, tx.langAuto);
    if (ui.langSel.value !== settings.lang) ui.langSel.value = settings.lang;
    setText(ui.diagSum, tx.diag);
    setText(ui.diagHint, tx.diagHint);
    setText(ui.diagRefresh, tx.diagRefresh);
    if (!ui.diagCopy.dataset.flash) setText(ui.diagCopy, tx.copy);
    setText(ui.foot, tx.foot);
    renderPanel();
    renderChip();
    renderDiag();
  }

  function renderPanel() {
    if (!ui) return;
    const tx = T();
    const busy = pressed || hook.inflight > 0;
    setText(ui.more, busy ? tx.fetching : tx.more);
    ui.more.disabled = busy;
  }

  function renderChip() {
    if (!ui) return;
    const st = chipState();
    setText(ui.status, T()[`st_${st}`]);
    ui.chip.dataset.state = st;
    ui.chip.classList.toggle('xod-paused', st === 'off');
    ui.chip.classList.toggle('xod-warn', st === 'broken' || st === 'silent' || st === 'failed');
  }

  // Line the chip and the panel up with the feed column (not the whole window),
  // so on desktop they never cover X's own sidebar or message drawer.
  function positionUI(main) {
    if (!ui) return;
    const col = main.querySelector('[data-testid="primaryColumn"]') || main;
    const r = col.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    let left = 0;
    let width = vw;
    if (r.width >= 240 && r.width <= vw + 1 && r.right > 0) {
      left = Math.max(0, r.left);
      width = Math.min(r.width, vw - left);
    }
    const L = `${Math.round(left)}px`;
    const W = `${Math.round(width)}px`;
    const s = ui.root.style;
    if (s.getPropertyValue('--xod-left') !== L) s.setProperty('--xod-left', L);
    if (s.getPropertyValue('--xod-width') !== W) s.setProperty('--xod-width', W);
  }

  // Match X's own theme (light / dim / lights-out), not the OS theme.
  function detectTheme() {
    if (!ui || !document.body) return;
    const bg = getComputedStyle(document.body).backgroundColor || '';
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return;
    const lum = (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255;
    ui.root.classList.toggle('xod-dark', lum < 0.5);
  }

  /* ───────────────────────────── diagnostics ───────────────────────────── */

  function fmtEvent(e) {
    if (!e || typeof e !== 'object') return '?';
    const t = `+${((Number(e.t) || 0) / 1000).toFixed(1)}s`;
    switch (e.k) {
      case 'req': return `${t} ${e.op} ${e.m} cursor=${e.c || '-'} ctx=${e.x || '-'} -> ${e.d}`;
      case 'hold': return `${t} HOLD #${e.id} ${e.op} ${e.c} (${e.why})`;
      case 'release': return `${t} RELEASE #${e.id} (${e.why}) after ${Math.round((e.waited || 0) / 1000)}s`;
      case 'done': return `${t} DONE #${e.id} ok=${e.ok} status=${e.status} ${e.ms}ms${e.why ? ` (${e.why})` : ''}`;
      case 'drop': return `${t} DROP #${e.id} (${e.why})`;
      case 'ui-gone': return `${t} INTERFACE GONE: no answer for ${Math.round((e.silent || 0) / 1000)}s, ${e.held} parked request(s) let through`;
      case 'ui-back': return `${t} interface is back`;
      case 'cursors': return `${t} cursors: +${e.n} (bottom=${e.b} top=${e.t})`;
      case 'error': return `${t} ERROR ${e.where}: ${e.msg}`;
      case 'start': return `${t} hook started v${e.v}${e.via ? ` via ${e.via}` : ''}`;
      default: return `${t} ${e.k}`;
    }
  }

  // What the page looks like to this extension: counts only, never any content. It shows why something is not found.
  function domProbe() {
    const count = (sel) => { try { return document.querySelectorAll(sel).length; } catch (e) { return '?'; } };
    let strips = '?';
    try {
      strips = Array.from(document.querySelectorAll('[role="tablist"]')).map((l) => {
        const tabs = Array.from(l.querySelectorAll('[role="tab"]'));
        const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
        return `${tabs.length}${i >= 0 ? `/sel${i}` : ''}`;
      }).join(' ') || 'none';
    } catch (e) { /* keep "?" */ }
    return `page structure: main=${count('main[role="main"]')}/${count('main')} primaryColumn=${count('[data-testid="primaryColumn"]')} tablists=[${strips}] posts=${count('[data-testid="cellInnerDiv"]')} scroller=${scroller ? 'inner' : 'window'} viewport=${window.innerWidth}x${window.innerHeight} touch=${navigator.maxTouchPoints || 0}`;
  }

  function diagText() {
    try {
      return buildDiag();
    } catch (err) {                  // e.g. a forged or damaged log message: the diagnostics must never break the interface
      return `OnDemand for X ${VERSION}\n(the diagnostics could not be put together)\nUA: ${navigator.userAgent}`;
    }
  }

  function buildDiag() {
    const L = hook.log;
    const s = (L && L.stats) || hook.stats || {};
    const lines = [];
    lines.push(`OnDemand for X ${VERSION}`);
    lines.push(`page: ${isHome() ? "/home" : "(not the home page)"}   enabled: ${settings.enabled}   lang: ${lang()}`);
    lines.push(`hook: ${hook.ready ? `ready${L ? ` (v${L.v})` : ''}${hook.via ? ` via ${hook.via}` : ''}` : hook.failed ? 'FAILED to load into the page' : 'not answering'}   injected: ${hook.injected}${failOpen ? '   FAIL-OPEN: the interface could not attach, pages flow freely' : ''}${L && L.gone ? '   INTERFACE-GONE: the hook heard nothing from the interface and lets pages flow' : ''}`);
    lines.push(`requests seen=${s.seen || 0} passed=${s.passed || 0} held=${s.held || 0} released=${s.released || 0} dropped=${s.dropped || 0} failed=${s.failed || 0} unparsed=${s.unparsed || 0} before-hook=${s.late || 0}`);
    if (L) {
      const c = L.cursors || {};
      lines.push(`cursors known: bottom=${c.b} top=${c.t} other=${c.o}`);
    }
    const held = Array.isArray(L && L.held) ? L.held : hook.held;
    lines.push(`waiting now: ${held.length ? held.map((e) => `${e.op} ${e.cursor} ${Math.round((e.age || 0) / 1000)}s`).join(', ') : 'none'}`);
    lines.push(`timeline on screen: ${activeOp() || 'unknown'}`);
    lines.push(domProbe());
    if (L && Array.isArray(L.ops) && L.ops.length) lines.push(`graphql operations seen: ${L.ops.map(([k, v]) => `${k}×${v}`).join(', ')}`);
    lines.push('--- log ---');
    if (L && Array.isArray(L.events)) for (const e of L.events.slice(-40)) lines.push(fmtEvent(e));
    else lines.push('(open this screen again to load the log)');
    lines.push('---');
    lines.push(`UA: ${navigator.userAgent}`);
    return lines.join('\n');
  }

  function renderDiag() {
    if (!ui || !ui.diagBox.open) return;
    setText(ui.diagPre, diagText());
  }

  async function copyDiag() {
    if (!ui) return;
    const text = ui.diagPre.textContent || diagText();
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      try {
        const range = document.createRange();
        range.selectNodeContents(ui.diagPre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('copy');
      } catch (e2) { ok = false; }
    }
    if (ok) {
      ui.diagCopy.dataset.flash = '1';
      setText(ui.diagCopy, T().copied);
      setTimeout(() => { delete ui.diagCopy.dataset.flash; setText(ui.diagCopy, T().copy); }, 1500);
    }
  }

  /* ───────────────────────────── the update loop ───────────────────────────── */

  function scheduleTick(delay) {
    if (tickTimer) return;
    tickTimer = setTimeout(doTick, delay === undefined ? SCROLL_THROTTLE_MS : delay);
  }

  function doTick() {
    tickTimer = 0;
    tickCount++;
    try { tick(); } catch (err) { log('tick error', err); }
  }

  function leaveHome() {
    homeSince = 0;
    setPanel(false);
    setSpacer(false);
    showUI(false);
  }

  // The interface attaches to X's main column. If that is missing for a while on /home (X changed its markup) while a
  // page is parked, nobody could ever press the button, so the hook is told to let everything through instead.
  function watchMissingMain() {
    const now = Date.now();
    if (!mainMissingSince) {
      mainMissingSince = now;
      setTimeout(scheduleTick, MAIN_MISSING_MS + 60);
      return;
    }
    if (!failOpen && now - mainMissingSince >= MAIN_MISSING_MS && hook.held.length) {
      failOpen = true;
      sendConfig();
    }
  }

  function resetMissingMain() {
    mainMissingSince = 0;
    if (failOpen) { failOpen = false; sendConfig(); }
  }

  function tick() {
    const home = isHome();
    const main = home ? findMain() : null;
    if (!main) {
      if (home) watchMissingMain(); else resetMissingMain();
      leaveHome();
      return;
    }
    resetMissingMain();
    if (!homeSince) {
      homeSince = Date.now();
      setTimeout(scheduleTick, SILENT_AFTER_MS + 60);       // re-draw the chip when "nothing intercepted" becomes true
    }

    ensureUI();
    lastModal = modalOpen();
    showUI(!lastModal);                 // stay out of the way of X's own dialogs and image viewer
    positionUI(main);
    detectTheme();
    pickScroller(main);
    updatePanel(main);
    renderPanel();
    renderChip();
    renderDiag();
  }

  // Polling is only for what no event announces: X mounting its page after a route change,
  // the UI being hidden/removed, and the hook not having answered yet.
  function needsPoll() {
    if (!isHome()) return false;
    return !ui || !ui.root.isConnected || !hook.ready || ui.root.style.display === 'none';
  }

  function routePoll() {
    if (document.hidden) return;                // a background tab has nothing to look after (visibilitychange calls this again)
    if (location.pathname !== lastRoute) {
      lastRoute = location.pathname;
      pressed = false;
      scheduleTick();
      return;
    }
    if (isHome() && modalOpen() !== lastModal) { scheduleTick(); return; }
    if (needsPoll()) scheduleTick();
  }

  function onScroll(e) {
    if (!panelOn && !waitingCount() && !hook.inflight) return;
    const tgt = e.target;
    if (scroller ? tgt !== scroller : (tgt !== document && tgt !== window)) return;
    scheduleTick();
  }

  /* ───────────────────────────── start-up ───────────────────────────── */

  function boot() {
    if (booted) return;
    booted = true;

    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', () => scheduleTick(), { passive: true });
    window.addEventListener('popstate', routePoll);
    document.addEventListener('visibilitychange', routePoll);
    try {
      if (window.navigation && window.navigation.addEventListener) {
        window.navigation.addEventListener('navigatesuccess', routePoll);
      }
    } catch (e) { /* optional */ }
    setInterval(routePoll, ROUTE_POLL_MS);
    document.addEventListener('DOMContentLoaded', () => scheduleTick(), { once: true });

    // settings changed in another tab
    try {
      if (hasExtStorage() && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes[STORAGE_KEY]) applySettings(sanitize(changes[STORAGE_KEY].newValue), false);
        });
      }
    } catch (e) { /* optional */ }
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY && !hasExtStorage()) {
        try { applySettings(sanitize(JSON.parse(e.newValue || 'null')), false); } catch (err) { /* ignore */ }
      }
    });

    sayHello();
    sendConfig();
    scheduleTick(0);
    setTimeout(scheduleTick, HOOK_GRACE_MS + 60);
  }

  window.addEventListener('message', onMessage, false);
  toHook({ type: 'hello' });                    // the page-world hook (a manifest content script) may be there already
  setTimeout(() => {                            // no answer: ask once more, then add the same file as a <script> tag
    if (hook.ready) return;
    toHook({ type: 'hello' });
    setTimeout(() => { if (!hook.ready) injectHook(); }, 100);
  }, HOOK_FALLBACK_MS);

  loadSettings((s) => {
    if (booted) { applySettings(s, false); return; }
    settings = s;
    boot();
  });
  // if storage never answers, run with the defaults
  setTimeout(boot, 1500);

  /* TEST-HOOKS-START */
  if (window.__XOD_TEST__) {
    if (window.__XOD_TEST__.graceMs) HOOK_GRACE_MS = window.__XOD_TEST__.graceMs;
    if (window.__XOD_TEST__.silentMs) SILENT_AFTER_MS = window.__XOD_TEST__.silentMs;
    if (window.__XOD_TEST__.mainMissingMs) MAIN_MISSING_MS = window.__XOD_TEST__.mainMissingMs;
    window.__xod = {
      state: () => ({
        ready: hook.ready,
        failed: hook.failed,
        via: hook.via,
        injected: hook.injected,
        failOpen,
        held: hook.held.map((e) => ({ ...e })),
        inflight: hook.inflight,
        stats: hook.stats ? { ...hook.stats } : null,
        panelOn,
        pressed,
        chip: chipState(),
        activeOp: activeOp(),
        scrollerIsInner: !!scroller,
        settings: { ...settings },
      }),
      tick: () => doTick(),
      ticks: () => tickCount,
      kill: () => window.removeEventListener('message', onMessage, false),     // as if the extension had been disabled: no answer to the hook any more
      lang: () => lang(),
      matchLang: (tag) => matchLang(tag),
      texts: () => ({ ...T() }),
      // shows the chip as it looks in one state (until the next update), to measure every status text
      previewChip: (state) => { if (ui) { ui.chip.dataset.state = state; setText(ui.status, T()[`st_${state}`]); } },
      set: (patch) => applySettings(sanitize({ ...settings, ...patch }), true),
      release: () => releaseNow(),
      diag: () => diagText(),
      log: () => hook.log,
    };
  }
  /* TEST-HOOKS-END */
})();
