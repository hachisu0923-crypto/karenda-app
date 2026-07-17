'use strict';
// Builds the graph the graph view draws: which nodes exist, what links them,
// how big they are. Pure — no DOM, no Supabase, no canvas.
// Loaded in the browser as a classic <script> (attaches to window) and required
// by tests/graph-model.test.js in Node (module.exports).
//
// Every policy decision lives here, so the view is only rendering:
//   - which tasks appear (not all of them)
//   - what a shift is called (its title is empty)
//   - which categories appear (only ones with something in the month)
//   - how node size follows the data
(function (root) {

  // stripInline() flattens [[Note|alias]] to "alias". Canvas draws text, not
  // HTML, so labels must be flattened. In the browser lib/md-inline.js has
  // already put it on window; in Node we require it.
  var stripInline;
  if (typeof module !== 'undefined' && module.exports) {
    stripInline = require('./md-inline.js').stripInline;
  } else {
    stripInline = root.stripInline;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // year, month(0-11) -> 'YYYY-MM'
  function monthKey(year, month) { return year + '-' + pad2(month + 1); }

  function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }

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

  // { year, month(0-11), events, categories, tasks } -> { nodes, edges, adj }
  //
  //   nodes: { id, kind:'date'|'event'|'task'|'cat', label, color?, key?, ref?, degree, r }
  //   edges: { source, target }        (ids)
  //   adj:   Map<id, Set<id>>          (for hover highlighting)
  //
  // `color` is only set where the data supplies one (categories and their
  // events). Days and tasks are left without one so the view can use its theme
  // tokens — the model must not know about CSS.
  function buildGraph(opts) {
    var year = opts.year;
    var month = opts.month;
    var events = opts.events || {};
    var categories = opts.categories || [];
    var tasks = opts.tasks || [];

    var mk = monthKey(year, month);
    var catById = new Map();
    categories.forEach(function (c) { catById.set(c.id, c); });

    var nodes = [];
    var edges = [];
    var byId = new Map();
    var usedCats = new Set();

    function add(node) { nodes.push(node); byId.set(node.id, node); return node; }
    function link(a, b) { edges.push({ source: a, target: b }); }

    // ── day nodes: every day of the month, even empty ones ───────────────────
    // An empty day is information (it is a gap), and dropping it would make the
    // month look denser than it is.
    var dim = daysInMonth(year, month);
    for (var d = 1; d <= dim; d++) {
      var key = mk + '-' + pad2(d);
      add({ id: 'date:' + key, kind: 'date', label: String(d), key: key, degree: 0 });
    }

    // ── event nodes ─────────────────────────────────────────────────────────
    Object.keys(events).forEach(function (key) {
      if (key.slice(0, 7) !== mk) return;                  // other months
      var dateId = 'date:' + key;
      if (!byId.has(dateId)) return;                       // malformed key
      (events[key] || []).forEach(function (ev, i) {
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
        link(id, dateId);
        if (cat) {
          link(id, 'cat:' + cat.id);
          usedCats.add(cat.id);
        }
      });
    });

    // ── task nodes ──────────────────────────────────────────────────────────
    // Only tasks that belong to this month and are still open:
    //   - no due date  -> belongs to no month at all; the graph is month-scoped
    //   - done         -> the month grid hides these too, so the graph does
    // Tasks load for all time with no date filter, so without this the node
    // count would only ever grow.
    tasks.forEach(function (t) {
      if (t.done) return;
      if (!t.dueDate) return;
      if (t.dueDate.slice(0, 7) !== mk) return;
      var dateId = 'date:' + t.dueDate;
      if (!byId.has(dateId)) return;                       // e.g. the 31st of a 30-day month
      var id = 'task:' + t.id;
      add({ id: id, kind: 'task', label: stripInline(t.title || '(無題)'), key: t.dueDate, ref: t, degree: 0 });
      link(id, dateId);
    });

    // ── category nodes ──────────────────────────────────────────────────────
    // Only categories something in this month actually points at. An unused
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
    monthKey: monthKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.graphModel = api;

})(typeof window !== 'undefined' ? window : globalThis);
