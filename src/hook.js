/*
 * OnDemand for X — page hook
 *
 * This file runs inside X's own page (the page's JavaScript world), because only
 * there can it see X's network calls. It does exactly one thing:
 *
 *   When X asks the server for the NEXT page of the Home timeline (the request
 *   that normally fires by itself as you scroll down), the request is parked here,
 *   unsent, until the extension's interface asks for it. Until then the server is
 *   never contacted, so it never "delivers" posts that you did not ask for.
 *
 * Everything else goes through untouched: the first load, pull-to-refresh, "show N
 * new posts", and every other request X makes.
 *
 * Design rules
 *  - Fail OPEN. Any unexpected situation means "send the request normally".
 *  - A bug of this file never reaches X's code: every patched function falls back to the original. (The one thing
 *    X can notice is a parked request that it cancels itself, or that a refresh made obsolete: that one is cancelled
 *    the way the browser would cancel it.)
 *  - Never keep X waiting for a button nobody can press: if the interface does not answer, whatever is parked is let go.
 *  - No network access of its own, no data leaves the page.
 *  - Talks to the extension's content script only through window.postMessage.
 */
(() => {
  'use strict';

  // Some browsers ignore the manifest's "world": "MAIN" and run this file in the extension's own world. There it could
  // only patch private copies of XMLHttpRequest / fetch that X never uses, and the interface would think all is well.
  // So here it does nothing at all; the content script notices that no hook answered and adds this same file to the
  // page as a <script> tag, which always runs in the page's world (where `chrome.runtime` does not exist).
  try {
    if (typeof chrome === 'object' && chrome && chrome.runtime && chrome.runtime.id) return;
  } catch (e) { /* not an extension world */ }

  if (window.__xodHook) return;
  try { Object.defineProperty(window, '__xodHook', { value: true }); } catch (e) { window.__xodHook = true; }

  const VERSION = '0.9.1';
  // how this file reached the page: as a <script> tag (then it is the running script) or as a manifest content script
  const VIA = (() => {
    try { return document.currentScript && document.currentScript.src ? 'script tag' : 'manifest'; } catch (e) { return 'manifest'; }
  })();
  const CH = 'xod-1';                                              // message channel marker
  const HOME_OP = /\/graphql\/[^/]+\/(HomeTimeline|HomeLatestTimeline)$/;
  const ANY_OP = /\/graphql\/[^/?#]+\/([A-Za-z0-9_]+)/;
  const MAX_LOG = 80;
  const MAX_OPS = 60;
  const MAX_CURSORS = 200;
  const RETRY_WINDOW_MS = 10 * 60 * 1000;                           // after a failed release, X's retry may pass
  let WATCH_EVERY_MS = 3000;                                        // while something is parked or loading it is looked after this often
  let UI_SILENT_MS = 15000;                                         // a parked request, the interface has not answered a ping for this long: let it go
  let INFLIGHT_MAX_MS = 90000;                                      // a released request with no end after this long stops blocking the button
  const T0 = Date.now();
  // X's page may replace the timer functions later; these are the ones that were there first
  const setIv = window.setInterval.bind(window);
  const clearIv = window.clearInterval.bind(window);

  /* ───────────────────────────── state ───────────────────────────── */

  const cfg = { enabled: true, uiGone: false };
  const held = [];                                                  // parked requests, oldest first
  const inflight = new Set();                                       // released, not finished yet
  let uiAt = 0;                                                     // when the interface last said anything (0 = it never did)
  let pingAt = 0;                                                   // when the last ping went out
  let watchTimer = 0;
  const cursors = { bottom: new Set(), top: new Set(), other: new Set() };
  const stats = { seen: 0, passed: 0, held: 0, released: 0, dropped: 0, failed: 0, unparsed: 0, late: 0 };
  const ops = new Map();                                            // every GraphQL operation name seen -> count (diagnostics)
  const events = [];                                                // small ring buffer for the diagnostics screen
  let credit = { n: 0, until: 0 };
  let seq = 0;
  let relAck = 0;                                                   // the last release command from the page that was handled

  /* ───────────────────────────── helpers ───────────────────────────── */

  function note(kind, extra) {
    const e = { t: Date.now() - T0, k: kind };
    if (extra) for (const key of Object.keys(extra)) e[key] = extra[key];
    events.push(e);
    if (events.length > MAX_LOG) events.shift();
  }

  function post(msg) {
    try {
      const out = { __xod: CH, from: 'hook' };
      for (const key of Object.keys(msg)) out[key] = msg[key];
      window.postMessage(out, location.origin);
    } catch (e) { /* ignore */ }
  }

  // a short, harmless label for a cursor (never the cursor itself) for the diagnostics
  function tag(c) {
    return typeof c === 'string' && c ? `${c.slice(0, 6)}…${c.length}` : '';
  }

  function countOp(urlText) {
    const m = ANY_OP.exec(urlText);
    if (!m) return;
    if (!ops.has(m[1]) && ops.size >= MAX_OPS) return;
    ops.set(m[1], (ops.get(m[1]) || 0) + 1);
  }

  function matchHome(urlText) {
    try {
      const url = new URL(urlText, location.href);
      const m = HOME_OP.exec(url.pathname);
      return m ? { op: m[1], url } : null;
    } catch (e) { return null; }
  }

  // the GraphQL "variables": in the query string (GET) or in the JSON body (POST)
  function readVars(url, bodyText) {
    let v = null;
    try {
      const s = url.searchParams.get('variables');
      if (s) v = JSON.parse(s);
    } catch (e) { v = null; }
    if (!v && typeof bodyText === 'string' && bodyText) {
      try {
        const b = JSON.parse(bodyText);
        if (b && typeof b === 'object' && b.variables && typeof b.variables === 'object') v = b.variables;
      } catch (e) { v = null; }
    }
    return v && typeof v === 'object' ? v : null;
  }

  function remember(set, value) {
    set.add(value);
    if (set.size > MAX_CURSORS) set.delete(set.values().next().value);
  }

  // Learn which cursor is the "Bottom" one (next page), which is "Top" (newer posts)
  // from the server's own responses. Works on any JSON shape: it just looks for
  // objects that carry both `cursorType` and `value`.
  function harvest(src) {
    let root = src;
    if (typeof src === 'string') {
      if (src.length > 12e6 || src.indexOf('cursorType') < 0) return 0;
      try { root = JSON.parse(src); } catch (e) { return 0; }
    }
    if (!root || typeof root !== 'object') return 0;
    let found = 0;
    let visited = 0;
    const stack = [root];
    while (stack.length && visited < 400000) {
      const n = stack.pop();
      visited++;
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length; i++) stack.push(n[i]);
        continue;
      }
      if (typeof n.cursorType === 'string' && typeof n.value === 'string' && n.value) {
        remember(n.cursorType === 'Bottom' ? cursors.bottom : n.cursorType === 'Top' ? cursors.top : cursors.other, n.value);
        found++;
      }
      for (const key in n) {
        const child = n[key];
        if (child && typeof child === 'object') stack.push(child);
      }
    }
    if (found) note('cursors', { n: found, b: cursors.bottom.size, t: cursors.top.size });
    return found;
  }

  /* ───────────────────────────── the decision ───────────────────────────── */

  // 'hold' only for a request for the NEXT page (older posts). Anything that does not
  // look exactly like that passes through, with one deliberate exception: a cursor this file has never seen. It is held
  // (kind 'unknown') because the file may have started after X's first reply (a browser that adds it late), or X may be
  // showing a timeline it restored from its own cache. Whatever is held can always be let go: by the button, by switching
  // the extension off, and by the valves (the interface not answering, its page structure missing).
  function decide(vars) {
    if (!cfg.enabled) return { act: 'pass', why: 'off' };
    if (!uiAt || cfg.uiGone) return { act: 'pass', why: 'no-ui' };    // nobody could ever press the button
    if (!vars) return { act: 'pass', why: 'unparsed' };
    const c = typeof vars.cursor === 'string' ? vars.cursor : '';
    if (!c) return { act: 'pass', why: 'first' };                   // first load / refresh: no cursor
    const kind = cursors.bottom.has(c) ? 'bottom' : cursors.top.has(c) ? 'top' : cursors.other.has(c) ? 'other' : '';
    if (kind === 'top' || kind === 'other') return { act: 'pass', why: kind };
    if (!kind && /^ptr$/i.test(String(vars.requestContext || ''))) return { act: 'pass', why: 'refresh' };
    if (credit.n > 0 && Date.now() < credit.until) {
      credit = { n: credit.n - 1, until: credit.until };
      return { act: 'pass', why: 'retry' };
    }
    return { act: 'hold', why: kind || 'unknown' };
  }

  function record(op, method, vars, d) {
    stats.seen++;
    if (d.act === 'pass') stats.passed++;
    if (d.why === 'unparsed') stats.unparsed++;
    note('req', {
      op,
      m: method,
      c: vars ? tag(vars.cursor) : '',
      x: vars && vars.requestContext ? String(vars.requestContext).slice(0, 12) : '',
      d: `${d.act}:${d.why}`,
    });
    if (d.act === 'pass') publish();                              // (a parked request publishes itself)
  }

  /* ───────────────────────────── parking requests ───────────────────────────── */

  function publicEntry(e) {
    return { id: e.id, op: e.op, why: e.why, cursor: e.label, age: Date.now() - e.t };
  }

  function publish() {
    post({
      type: 'state',
      held: held.map(publicEntry),
      inflight: inflight.size,
      credit: credit.n > 0 && Date.now() < credit.until ? credit.n : 0,
      ack: relAck,
      gone: cfg.uiGone,
      stats,
    });
  }

  function newEntry(kind, op, vars, why) {
    return {
      id: ++seq, kind, op, why,
      cur: vars && typeof vars.cursor === 'string' ? vars.cursor : '',
      label: vars ? tag(vars.cursor) : '',
      t: Date.now(), t1: 0, state: 'held', xhr: null, go: null, cancel: null,
    };
  }

  function park(e) {
    held.push(e);
    stats.held++;
    note('hold', { id: e.id, op: e.op, c: e.label, why: e.why });
    ensureWatch();
    publish();
  }

  // ok: true = answered 2xx, false = failed, null = ended without an answer (cancelled, re-opened, or no end in sight)
  function finish(e, ok, status, why) {
    if (e.state === 'done') return;
    e.state = 'done';
    inflight.delete(e);
    if (ok === true) {
      credit = { n: 0, until: 0 };
    } else if (ok === false) {
      stats.failed++;
      credit = { n: 1, until: Date.now() + RETRY_WINDOW_MS };      // X's own retry must not be parked again
    }
    const ms = Date.now() - (e.t1 || e.t);
    note('done', { id: e.id, ok, status, ms, why: why || '' });
    post({ type: 'done', id: e.id, ok, status, ms });
    publish();
  }

  /* ───────────────────────────── looking after what is parked or loading ───────────────────────────── */

  // Runs only while something is parked or loading (a timer that stops by itself). Two jobs:
  //  1. a released request that has no end after INFLIGHT_MAX_MS is let go of, so that the button is not blocked for good
  //     (X may have re-opened its XHR, or the connection may be stuck);
  //  2. a parked request while the interface does not answer: the hook asks (ping), the interface answers at once from
  //     its message handler (pong) — not from a timer, so a hidden tab cannot cause a false alarm. No answer for
  //     UI_SILENT_MS means nobody can press the button (the extension was updated, disabled or broke): everything parked
  //     is released and nothing is parked again until the interface speaks again.
  function ensureWatch() {
    if (watchTimer) return;
    try { watchTimer = setIv(watch, WATCH_EVERY_MS); } catch (e) { watchTimer = 0; }
  }

  function watch() {
    try {
      const now = Date.now();
      for (const e of Array.from(inflight)) {
        if (now - e.t1 > INFLIGHT_MAX_MS) finish(e, null, 0, 'no end');
      }
      if (held.length) {
        if (uiAt >= pingAt) {                                       // the last ping was answered (or there was none)
          pingAt = now;
          post({ type: 'ping' });
        } else if (now - pingAt >= UI_SILENT_MS) {
          cfg.uiGone = true;
          note('ui-gone', { held: held.length, silent: now - pingAt });
          releaseAll('interface gone');
          publish();
        }
      }
    } catch (e) {
      note('error', { where: 'watch', msg: String((e && e.message) || e) });
    }
    if (!held.length && !inflight.size && watchTimer) {
      try { clearIv(watchTimer); } catch (e) { /* ignore */ }
      watchTimer = 0;
    }
  }

  function release(e, why) {
    const i = held.indexOf(e);
    if (i < 0 || e.state !== 'held') return;
    held.splice(i, 1);
    e.state = 'released';
    e.t1 = Date.now();
    inflight.add(e);
    ensureWatch();
    stats.released++;
    note('release', { id: e.id, why, waited: e.t1 - e.t });
    try {
      e.go();
    } catch (err) {
      note('error', { where: 'release', msg: String((err && err.message) || err) });
      finish(e, false, -1);
    }
    publish();
  }

  // Release the page that is waiting for one timeline (all duplicates of the same cursor).
  // If several cursors are waiting for the same timeline, the NEWEST one is the feed on screen: the
  // older ones were asked for by a feed that X has since replaced (after a refresh) and are
  // forgotten, never sent. If X still treats an old one as valid it is the only one that exists,
  // and then it is the one released.
  function releaseNext(op) {
    const cands = held.filter((e) => !op || e.op === op);
    if (!cands.length) return 0;
    const newest = cands[cands.length - 1];
    for (const e of cands) if (e.op === newest.op && e.cur !== newest.cur) drop(e, 'superseded');
    const group = cands.filter((e) => e.cur === newest.cur && e.state === 'held');
    for (const e of group) release(e, 'user');
    return group.length;
  }

  function releaseAll(why) {
    for (const e of held.slice()) release(e, why);
  }

  function drop(e, why) {
    const i = held.indexOf(e);
    if (i < 0) return;
    held.splice(i, 1);
    e.state = 'dropped';
    stats.dropped++;
    note('drop', { id: e.id, why });
    try { if (e.cancel) e.cancel(); } catch (err) { /* ignore */ }
    publish();
  }

  /* ───────────────────────────── XMLHttpRequest ───────────────────────────── */

  const xhrMeta = new WeakMap();                                    // xhr -> { method, home, entry } for its current open()
  const xhrWatched = new WeakSet();                                 // xhr objects that already carry our listeners

  function patch(obj, name, make) {
    const native = obj[name];
    if (typeof native !== 'function') return false;
    const wrapped = make(native);
    try {
      Object.defineProperty(obj, name, { value: wrapped, writable: true, configurable: true, enumerable: false });
      return true;
    } catch (e) {
      try { obj[name] = wrapped; return true; } catch (e2) { return false; }
    }
  }

  // X re-opened or aborted this XMLHttpRequest object: what of ours depended on its previous request is over.
  // A parked one is forgotten (never sent). A released one that is still loading would never get its 'load' event
  // (open() ends a request silently), so it is finished here.
  function dropFor(xhr) {
    for (const e of held.slice()) if (e.xhr === xhr) drop(e, 'xhr reopened or aborted');
    for (const e of Array.from(inflight)) if (e.xhr === xhr) finish(e, null, 0, 'xhr reopened or aborted');
  }

  function xhrBody(xhr) {
    const rt = xhr.responseType;
    if (rt === '' || rt === 'text') return xhr.responseText;
    if (rt === 'json') return xhr.response;
    return null;
  }

  // One set of listeners per XMLHttpRequest object, however often X re-uses it. What they do follows the object's
  // current request: the reply is read for cursors only if it is a Home-timeline request, and the entry that was
  // parked and then released (if any) is finished.
  function watchXhr(xhr) {
    if (xhrWatched.has(xhr)) return;
    xhrWatched.add(xhr);
    const mine = () => { const m = xhrMeta.get(xhr); return m && m.entry ? m.entry : null; };
    xhr.addEventListener('load', () => {
      const m = xhrMeta.get(xhr);
      if (!m || !m.home) return;
      const ok = xhr.status >= 200 && xhr.status < 300;
      if (ok) {
        try { harvest(xhrBody(xhr)); } catch (e) { /* ignore */ }
      }
      const e = mine();
      if (e) finish(e, ok, xhr.status);
    });
    xhr.addEventListener('error', () => { const e = mine(); if (e) finish(e, false, 0); });
    xhr.addEventListener('timeout', () => { const e = mine(); if (e) finish(e, false, 0); });
    xhr.addEventListener('abort', () => { const e = mine(); if (e) finish(e, null, 0); });
  }

  // returns true when the request was parked (the caller must NOT send it)
  function interceptXhr(xhr, body, native, args) {
    const meta = xhrMeta.get(xhr);
    if (!meta || !meta.home) return false;
    const { op, url } = meta.home;
    const vars = readVars(url, typeof body === 'string' ? body : null);
    const d = decide(vars);
    record(op, meta.method, vars, d);
    if (d.act !== 'hold') {
      watchXhr(xhr);
      return false;
    }
    const e = newEntry('xhr', op, vars, d.why);
    e.xhr = xhr;
    e.go = () => {
      meta.entry = e;
      watchXhr(xhr);
      native.apply(xhr, args);
    };
    park(e);
    return true;
  }

  patch(XMLHttpRequest.prototype, 'open', (native) => function open(method, url) {
    try {
      dropFor(this);
      const text = String(url);
      countOp(text);
      xhrMeta.set(this, { method: String(method || 'GET').toUpperCase(), home: matchHome(text), entry: null });
    } catch (e) { /* never break X */ }
    return native.apply(this, arguments);
  });

  patch(XMLHttpRequest.prototype, 'send', (native) => function send(body) {
    let parked = false;
    try {
      parked = interceptXhr(this, body, native, arguments);
    } catch (e) {
      parked = false;
      note('error', { where: 'xhr', msg: String((e && e.message) || e) });
    }
    if (parked) return undefined;
    return native.apply(this, arguments);
  });

  patch(XMLHttpRequest.prototype, 'abort', (native) => function abort() {
    try { dropFor(this); } catch (e) { /* ignore */ }
    return native.apply(this, arguments);
  });

  /* ───────────────────────────── fetch (safety net) ───────────────────────────── */

  function abortError() {
    try { return new DOMException('The operation was aborted.', 'AbortError'); } catch (e) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      return err;
    }
  }

  function watchFetch(promise, entry) {
    return promise.then((res) => {
      try {
        const ok = !!res && res.ok === true;
        if (ok && typeof res.clone === 'function') {
          res.clone().text().then((text) => { harvest(text); }, () => { /* ignore */ });
        }
        if (entry) finish(entry, ok, res ? res.status : 0);
      } catch (e) { /* ignore */ }
      return res;
    }, (err) => {
      try { if (entry) finish(entry, err && err.name === 'AbortError' ? null : false, 0); } catch (e) { /* ignore */ }
      throw err;
    });
  }

  async function fetchHome(self, native, args, input, init, home, method) {
    let bodyText = null;
    try {
      if (init && typeof init.body === 'string') {
        bodyText = init.body;
      } else if (!(init && init.body != null) && input && typeof input === 'object' &&
                 typeof input.clone === 'function' && method !== 'GET' && method !== 'HEAD') {
        bodyText = await input.clone().text();
      }
    } catch (e) { bodyText = null; }

    let vars = null;
    let d;
    try {
      vars = readVars(home.url, bodyText);
      d = decide(vars);
      record(home.op, method, vars, d);
    } catch (e) {
      d = { act: 'pass', why: 'error' };
    }
    if (d.act !== 'hold') return watchFetch(native.apply(self, args), null);

    return new Promise((resolve, reject) => {
      const e = newEntry('fetch', home.op, vars, d.why);
      const sig = (init && init.signal) || (input && typeof input === 'object' && input.signal) || null;
      e.go = () => {
        let p;
        try { p = native.apply(self, args); } catch (err) { reject(err); throw err; }
        watchFetch(p, e).then(resolve, reject);
      };
      e.cancel = () => reject(abortError());
      if (sig) {
        if (sig.aborted) { reject(abortError()); return; }
        sig.addEventListener('abort', () => { if (e.state === 'held') drop(e, 'signal'); }, { once: true });
      }
      park(e);
    });
  }

  patch(window, 'fetch', (native) => function fetch(input, init) {
    let home = null;
    let method = 'GET';
    try {
      const text = typeof input === 'string' ? input : (input && input.url) || String(input);
      countOp(text);
      home = matchHome(text);
      if (home) method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    } catch (e) { home = null; }
    if (!home) return native.apply(this, arguments);
    return fetchHome(this, native, arguments, input, init, home, method);
  });

  /* ───────────────────────────── talking to the extension ───────────────────────────── */

  window.addEventListener('message', (ev) => {
    try {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.__xod !== CH || d.from !== 'ui') return;
      uiAt = Date.now();                                            // the interface is there (any message of it counts)
      if (cfg.uiGone) { cfg.uiGone = false; note('ui-back'); publish(); }
      if (d.type === 'pong') return;
      if (d.type === 'hello') {
        post({ type: 'ready', v: VERSION, via: VIA, late: stats.late });
        publish();
      } else if (d.type === 'config') {
        cfg.enabled = d.enabled !== false;
        if (!cfg.enabled) releaseAll('disabled');                   // switched off: never leave X waiting
        publish();
      } else if (d.type === 'release') {
        if (Number(d.seq) > relAck) relAck = Number(d.seq);
        releaseNext(typeof d.op === 'string' ? d.op : null);
        publish();                                                  // always answer, even when nothing was waiting
      } else if (d.type === 'getlog') {
        post({
          type: 'log',
          v: VERSION,
          via: VIA,
          enabled: cfg.enabled,
          gone: cfg.uiGone,
          events: events.slice(),
          ops: Array.from(ops),
          stats,
          cursors: { b: cursors.bottom.size, t: cursors.top.size, o: cursors.other.size },
          held: held.map(publicEntry),
          inflight: inflight.size,
        });
      }
    } catch (e) { /* ignore */ }
  }, false);

  // requests that X made before this hook was installed (diagnostics only)
  try {
    for (const r of performance.getEntriesByType('resource')) {
      if (r.initiatorType !== 'xmlhttprequest' && r.initiatorType !== 'fetch') continue;
      if (matchHome(r.name)) stats.late++;
    }
  } catch (e) { /* ignore */ }

  /* TEST-HOOKS-START */
  try {
    const t = window.__XOD_TEST__;
    if (t && t.uiSilentMs) UI_SILENT_MS = t.uiSilentMs;
    if (t && t.watchMs) WATCH_EVERY_MS = t.watchMs;
    if (t && t.inflightMaxMs) INFLIGHT_MAX_MS = t.inflightMaxMs;
  } catch (e) { /* tests only */ }
  /* TEST-HOOKS-END */

  note('start', { v: VERSION, via: VIA });
  post({ type: 'ready', v: VERSION, via: VIA, late: stats.late });
})();
