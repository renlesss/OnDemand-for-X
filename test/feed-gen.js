/*
 * Deterministic fake feed + fake X "server", shared by the mock page (browser) and
 * the test runner (node).
 *
 * Item types (they mimic what really shows up in X's home feed):
 *   post    normal post with a /user/status/<id> link and a <time> link
 *   repost  post whose status link points at the ORIGINAL post
 *   ad      promoted post: an article, but no /status/ link and no <time>
 *   module  "Who to follow" style cell: no article at all
 *
 * The server side answers like X's GraphQL timeline endpoints do:
 *   - no cursor            -> first page of a brand-new feed (+ Top and Bottom cursor entries)
 *   - a Bottom cursor      -> the NEXT (older) page
 *   - a Top cursor         -> newer posts only
 * Cursors are opaque strings that carry (kind, operation, feed, position).
 */
(function (root) {
  function item(epoch, i) {
    const base = epoch * 1000000;
    let type = 'post';
    if (i % 9 === 4) type = 'module';
    else if (i % 13 === 7) type = 'ad';
    else if (i % 11 === 5) type = 'repost';

    const h = type === 'module' ? 220 : type === 'ad' ? 260 : 100 + ((i * 53) % 260);
    const user = `user${i % 7}`;
    let pid = null;
    let href = null;

    if (type === 'post') {
      pid = `p${base + 1000 + i}`;
      href = `/${user}/status/${base + 1000 + i}`;
    } else if (type === 'repost') {
      const dup = i === 16;
      const id = dup ? base + 1003 : base + 500000 + i;
      pid = `p${id}`;
      href = `/${dup ? 'user3' : `orig${i % 5}`}/status/${id}`;
    } else if (type === 'ad') {
      pid = `ad${base + i}`;
    }

    return {
      i, type, h, pid, href, user,
      text: type === 'ad' ? `Promoted: buy gadget number ${i} today` : `Post number ${i} in feed ${epoch}`,
    };
  }

  // a post that arrives "on top" (newer than everything on screen)
  function fresh(epoch, k) {
    return { i: -1 - k, type: 'post', h: 150, pid: `n${epoch}_${k}`, href: `/newuser/status/${900000 + k}`, user: 'newuser', text: `Brand new post ${k} in feed ${epoch}` };
  }

  /* ───────────────────────────── fake server ───────────────────────────── */

  const PAD = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const MAX_ITEMS = 120;                       // the feed "ends" after this many items

  function makeCursor(kind, op, epoch, pos) { return `DAAC${kind}_${op}_${epoch}_${pos}_${PAD}`; }

  function parseCursor(c) {
    const m = /^DAAC([BTG])_(HomeTimeline|HomeLatestTimeline)_(\d+)_(\d+)_A+$/.exec(String(c || ''));
    return m ? { kind: m[1], op: m[2], epoch: Number(m[3]), pos: Number(m[4]) } : null;
  }

  function cursorEntry(kind, value, id) {
    return {
      entryId: `cursor-${kind === 'B' ? 'bottom' : 'top'}-${id}`,
      sortIndex: String(id),
      content: {
        entryType: 'TimelineTimelineCursor',
        __typename: 'TimelineTimelineCursor',
        value,
        cursorType: kind === 'B' ? 'Bottom' : 'Top',
      },
    };
  }

  function itemEntry(it) {
    if (it.type === 'module') {
      return { entryId: `module-${it.i}`, sortIndex: String(1e6 - it.i), content: { entryType: 'TimelineTimelineModule', __typename: 'TimelineTimelineModule', mock: it } };
    }
    return {
      entryId: `tweet-${it.pid}`,
      sortIndex: String(1e6 - it.i),
      content: {
        entryType: 'TimelineTimelineItem',
        __typename: 'TimelineTimelineItem',
        itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { __typename: 'Tweet', rest_id: it.pid, mock: it } } },
      },
    };
  }

  function body(entries, epoch) {
    return {
      data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineAddEntries', entries }] } } },
      mock: { epoch },
    };
  }

  /*
   * opts: { op, cursor, count, epoch }   `epoch` is the feed number to give to a brand-new feed
   * returns { status, json }
   */
  function timeline(opts) {
    const op = opts.op;
    const count = Math.max(1, Math.min(100, Number(opts.count) || 20));
    const c = opts.cursor ? parseCursor(opts.cursor) : null;

    if (opts.cursor && (!c || c.op !== op)) return { status: 400, json: { errors: [{ message: 'bad cursor' }] } };

    if (!c) {
      const ep = opts.epoch;
      const entries = [];
      for (let i = 0; i < count; i++) entries.push(itemEntry(item(ep, i)));
      entries.push(cursorEntry('T', makeCursor('T', op, ep, 0), `${ep}-0`));
      if (count < MAX_ITEMS) entries.push(cursorEntry('B', makeCursor('B', op, ep, count), `${ep}-${count}`));
      return { status: 200, json: body(entries, ep) };
    }

    if (c.kind === 'B') {
      const entries = [];
      const end = Math.min(c.pos + count, MAX_ITEMS);
      for (let i = c.pos; i < end; i++) entries.push(itemEntry(item(c.epoch, i)));
      entries.push(cursorEntry('T', makeCursor('T', op, c.epoch, 0), `${c.epoch}-0`));
      if (end < MAX_ITEMS) entries.push(cursorEntry('B', makeCursor('B', op, c.epoch, end), `${c.epoch}-${end}`));
      return { status: 200, json: body(entries, c.epoch) };
    }

    // Top cursor: newer posts only (3 of them per poll)
    const entries = [];
    for (let k = c.pos; k < c.pos + 3; k++) entries.push(itemEntry(fresh(c.epoch, k)));
    entries.push(cursorEntry('T', makeCursor('T', op, c.epoch, c.pos + 3), `${c.epoch}-top${c.pos + 3}`));
    return { status: 200, json: body(entries, c.epoch) };
  }

  /* ───────────────────────────── expectations ───────────────────────────── */

  // first n UNIQUE post ids of a feed, in feed order (modules have no article)
  function expectedPids(epoch, n) {
    const seen = new Set();
    const out = [];
    for (let i = 0; out.length < n && i < 5000; i++) {
      const it = item(epoch, i);
      if (it.type === 'module' || seen.has(it.pid)) continue;
      seen.add(it.pid);
      out.push(it.pid);
    }
    return out;
  }

  const api = { item, fresh, timeline, makeCursor, parseCursor, expectedPids, MAX_ITEMS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FeedGen = api;
})(typeof window !== 'undefined' ? window : globalThis);
