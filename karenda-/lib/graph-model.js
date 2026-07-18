'use strict';
// Builds the graph the graph view draws: which nodes exist, what links them,
// how big they are. Pure — no DOM, no Supabase, no canvas.
// Loaded in the browser as a classic <script> (attaches to window) and required
// by tests/graph-model.test.js in Node (module.exports).
//
// Every policy decision lives here, so the view is only rendering:
//   - which days appear (a 7-day window from today, not a whole month)
//   - which tasks appear (not all of them)
//   - what a shift is called (its title is empty)
//   - which categories appear (only ones with something in the window)
//   - how node size follows the data
(function (root) {

  // stripInline() flattens [[Note|alias]] to "alias". Canvas draws text, not
  // HTML, so labels must be flattened. extractLinks() pulls the [[targets]] out
  // of a title so today's events can hang a node off each note they mention.
  // In the browser lib/md-inline.js has already put both on window; in Node we
  // require them.
  var stripInline, extractLinks;
  if (typeof module !== 'undefined' && module.exports) {
    var mdInline = require('./md-inline.js');
    stripInline = mdInline.stripInline;
    extractLinks = mdInline.extractLinks;
  } else {
    stripInline = root.stripInline;
    extractLinks = root.extractLinks;
  }

  // How much harder today's day node holds onto its own events and tasks.
  // The force layer reads a link's weight as "shorter and stiffer" — rest
  // length is linkDistance / weight, so 3 gathers today's cluster to ~83px
  // while every other day stays at the usual 250.
  var TODAY_LINK_WEIGHT = 3;

  // The graph shows this many days, starting at today. Seven is the user's ask
  // ("その日から7日以内"): today plus the six days after it, not today + 7.
  var WINDOW_DAYS = 7;

  function pad2(n) { return String(n).padStart(2, '0'); }

  // 'YYYY-MM-DD' + n days -> 'YYYY-MM-DD'. Date does the calendar arithmetic, so
  // month ends, month lengths and leap days come out right (2024-02-26 + 4 is
  // 2024-03-01, and + 3 is 2024-02-29) without this file knowing any of it.
  // Parsing 'YYYY-MM-DDT00:00:00' pins it to local midnight rather than UTC, so
  // no timezone can shift the result by a day — and it never reads the clock,
  // which keeps the model pure.
  function addDays(dateStr, n) {
    var d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // Obsidian sizes nodes by how many links they have. sqrt keeps a category
  // with 40 links from dwarfing a day with 4, while still ranking them.
  function nodeRadius(degree) {
    var r = 4 + 2.2 * Math.sqrt(degree || 0);
    return Math.max(4, Math.min(14, r));
  }

  // Topmost node whose circle contains the point, or null. Later nodes are
  // drawn on top, so scan backwards to match what the eye picks.
  function hitTest(nodes, wx, wy, slop) {
    var pad = slop || 0;
    for (var i = nodes.length - 1; i >= 0; i--) {
      var n = nodes[i];
      var dx = wx - n.x, dy = wy - n.y;
      var r = (n.r || 4) + pad;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  // { start:'YYYY-MM-DD', days?, events, categories, tasks, today? }
  //   -> { nodes, edges, adj }
  //
  //   nodes: { id, kind:'date'|'event'|'task'|'cat', label, color?, key?, ref?,
  //            pinned?, degree, r }
  //   edges: { source, target, weight } (ids; weight 1 unless today's)
  //   adj:   Map<id, Set<id>>          (for hover highlighting)
  //
  // `color` is only set where the data supplies one (categories and their
  // events). Days and tasks are left without one so the view can use its theme
  // tokens — the model must not know about CSS.
  //
  // The graph is scoped to a window of days — `days` of them, starting at
  // `start` — not to a month. The caller passes today as `start`, so the picture
  // is "the next week" and stays that whatever month the calendar is showing.
  // A window is what the user asked for and it also crosses month boundaries,
  // which a month scope cannot: events and tasks are all in memory with no date
  // filter, so a window running 7/28→8/03 has August's records to hand.
  //
  // `start` and `today` are 'YYYY-MM-DD' strings from the caller, not new Date().
  // The model stays pure: reading the wall clock here would make every test that
  // builds a fixed window pass today and fail next week.
  function buildGraph(opts) {
    var start = opts.start;
    var days = opts.days == null ? WINDOW_DAYS : opts.days;
    var events = opts.events || {};
    var categories = opts.categories || [];
    var tasks = opts.tasks || [];
    var today = opts.today || null;

    var catById = new Map();
    categories.forEach(function (c) { catById.set(c.id, c); });

    var nodes = [];
    var edges = [];
    var byId = new Map();
    var usedCats = new Set();

    function add(node) { nodes.push(node); byId.set(node.id, node); return node; }
    // Every edge carries a weight so the force layer never has to test for one.
    function link(a, b, w) { edges.push({ source: a, target: b, weight: w || 1 }); }

    // ── day nodes: every day in the window, even empty ones ─────────────────
    // An empty day is information (it is a gap), and dropping it would make the
    // week look busier than it is.
    // inWindow also decides which events and tasks survive below, so there is
    // one definition of "in range" rather than three.
    var inWindow = new Set();
    for (var i = 0; start && i < days; i++) inWindow.add(addDays(start, i));

    inWindow.forEach(function (key) {
      // The label is the day of the month, as the month grid writes it: the
      // window can span two months, so it restarts at 1 partway through.
      var day = {
        id: 'date:' + key, kind: 'date',
        label: String(parseInt(key.slice(8), 10)), key: key, degree: 0,
      };
      // Today is held at the origin, so it is always the middle of the picture
      // and the week arranges itself around it. Naming it here rather than in
      // the force layer keeps the policy ("which day is today") with every other
      // policy, and leaves the physics to say what being pinned means.
      //
      // Deliberately not the `fixed` flag: that one belongs to dragging and is
      // cleared on pointer-up (app.js dropDrag), so reusing it would silently
      // unpin today the first time anyone touched it.
      if (key === today) day.pinned = true;
      add(day);
    });

    // ── event nodes ─────────────────────────────────────────────────────────
    Object.keys(events).forEach(function (key) {
      if (!inWindow.has(key)) return;                      // outside the window
      var dateId = 'date:' + key;                          // a malformed key is
      (events[key] || []).forEach(function (ev, i) {       // not in the window
        var cat = catById.get(ev.catId);
        // A shift carries no title — the app shows the category name instead
        // (app.js buildCell). Fall back the same way, then to a placeholder so
        // a node is never a blank circle.
        var label = stripInline(ev.title || (cat && cat.name) || '(無題)');
        // _dbId is absent until Supabase assigns one, so fall back to position.
        var id = 'event:' + (ev._dbId != null ? ev._dbId : key + ':' + i);
        add({
          id: id, kind: 'event', label: label,
          color: cat ? cat.color : null,                   // unknown catId -> view decides
          key: key, ref: ev, degree: 0,
        });
        // Today's events hug their day. The category edge stays weight 1 on
        // purpose: pulling the category in too would drag along every other
        // day's events that share it, and smear the cluster back out.
        link(id, dateId, key === today ? TODAY_LINK_WEIGHT : 1);
        if (cat) {
          link(id, 'cat:' + cat.id);
          usedCats.add(cat.id);
        }
        // Today's events pull in the notes their titles mention. "本日の予定を
        // 中心にして、その予定内容をリンクで近くにして": the [[note]] written in a
        // title becomes its own node, held near the event (and so near the
        // origin) with the same weight that gathers today's cluster. Only
        // today's events do this — the other six days would spray notes across
        // the window and drown the point of the centre. The target (the part before
        // any '|') is the node; an alias is just display text on the link.
        // Several of today's events naming the same note share one node.
        if (key === today) {
          extractLinks(ev.title).forEach(function (target) {
            var noteId = 'note:' + target;
            if (!byId.has(noteId)) add({ id: noteId, kind: 'note', label: target, degree: 0 });
            link(id, noteId, TODAY_LINK_WEIGHT);
          });
        }
      });
    });

    // ── task nodes ──────────────────────────────────────────────────────────
    // Only tasks due inside the window and still open:
    //   - no due date  -> falls on no day at all; the graph is day-scoped
    //   - done         -> the month grid hides these too, so the graph does
    // Tasks load for all time with no date filter, so without this the node
    // count would only ever grow. A due date that names a day that does not
    // exist (2026-09-31) is not in the window either, so it drops out here
    // rather than dangling off a day node that was never built.
    tasks.forEach(function (t) {
      if (t.done) return;
      if (!t.dueDate) return;
      if (!inWindow.has(t.dueDate)) return;
      var dateId = 'date:' + t.dueDate;
      var id = 'task:' + t.id;
      add({ id: id, kind: 'task', label: stripInline(t.title || '(無題)'), key: t.dueDate, ref: t, degree: 0 });
      link(id, dateId, t.dueDate === today ? TODAY_LINK_WEIGHT : 1);
    });

    // ── category nodes ──────────────────────────────────────────────────────
    // Only categories something in the window actually points at. An unused
    // category would float alone and say nothing.
    categories.forEach(function (c) {
      if (!usedCats.has(c.id)) return;
      add({ id: 'cat:' + c.id, kind: 'cat', label: c.name, color: c.color, ref: c, degree: 0 });
    });

    // Edges were emitted before their category node existed; drop any that
    // still dangle rather than leaving an edge to nowhere.
    edges = edges.filter(function (e) { return byId.has(e.source) && byId.has(e.target); });

    // ── degree, radius, adjacency ───────────────────────────────────────────
    var adj = new Map();
    nodes.forEach(function (n) { adj.set(n.id, new Set()); });
    edges.forEach(function (e) {
      byId.get(e.source).degree++;
      byId.get(e.target).degree++;
      adj.get(e.source).add(e.target);
      adj.get(e.target).add(e.source);
    });
    nodes.forEach(function (n) { n.r = nodeRadius(n.degree); });

    return { nodes: nodes, edges: edges, adj: adj };
  }

  var api = {
    buildGraph: buildGraph,
    nodeRadius: nodeRadius,
    hitTest: hitTest,
    WINDOW_DAYS: WINDOW_DAYS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.graphModel = api;

})(typeof window !== 'undefined' ? window : globalThis);
