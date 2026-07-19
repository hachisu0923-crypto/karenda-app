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
  // length is linkDistance / weight, so 5 gathers today's cluster to 50px
  // (it settles at 66-82px once its own items repel each other) while every
  // other day stays at the usual 250.
  //
  // This has to stay above DAY_CHILD_WEIGHT below, or another day would hold
  // its events more tightly than today holds its own — the inversion the two
  // "linked to its day more heavily" tests catch. It is also what makes the
  // rest of the picture compact: today's cluster radius is what the first ring
  // has to clear, so pulling today in (~110px at 3, ~78px at 4, 66-82px at 5)
  // is what let NEAR_DAY_RING come down 240 -> 190 -> 155.
  var TODAY_LINK_WEIGHT = 5;

  // The graph shows this many days, starting at today. Seven is the user's ask
  // ("その日から7日以内"): today plus the six days after it, not today + 7.
  var WINDOW_DAYS = 7;

  // ── where every node belongs: rings and sectors around today ────────────────
  // "その日を中心して、それ以外の日を離して、予定をそれぞれの日から外側に繋がる
  // ように" — the picture is polar. Today is the origin; its own events sit on a
  // tight ring around it; the other six days each own a ring further out and a
  // sector of the circle; and a day's events and tasks sit beyond their own day,
  // in that day's sector. So the distance from the centre means one thing (how
  // far away in time) and the direction means another (which day this belongs
  // to).
  //
  // Springs alone cannot say that. A link only constrains the distance between
  // two nodes, so an event 250px from its day is as happy inside the ring as
  // outside it, and two days' clusters are free to overlap. The model therefore
  // gives each node an `anchor` — the world point it belongs at — and the force
  // layer pulls it there while repulsion still spreads out whatever crowds. The
  // links are kept in agreement with the anchors (rest length = the gap the
  // anchors ask for) so the two forces never fight.
  //
  // A weight is how the model states a rest length (the force layer makes it
  // linkDistance / weight), so to aim at a number of pixels the model has to
  // know what it is dividing — hence this copy of graph-force's default
  // linkDistance. Anchors are targets, not promises: repulsion from the rest of
  // the graph moves the settled positions somewhat.
  var LINK_DISTANCE = 250;
  var TAU = Math.PI * 2;
  // Slot zero points straight up, so the day after today reads as "12 o'clock"
  // rather than starting wherever atan2 happens to.
  var ANGLE_START = -Math.PI / 2;

  // Today's own events, tasks and notes: one ring just outside today itself.
  // Same distance TODAY_LINK_WEIGHT already asked for, so anchor and spring agree.
  var TODAY_RING = LINK_DISTANCE / TODAY_LINK_WEIGHT;   // 50px

  // The other days. The nearest ring starts well outside today's own cluster: if
  // tomorrow came in closer, the picture would say tomorrow matters more than
  // today's own schedule.
  //
  // "Well outside" is a measured number, not a taste. Today's ring holds however
  // many events, tasks and notes today happens to have, and repulsion inflates
  // it as they crowd (a day with 8 events, 8 notes and 4 tasks settles at ~100px
  // rather than 83). An event of today's sitting at radius rc, on the same
  // bearing as tomorrow, is nearer tomorrow than today the moment rc > R1 - rc.
  // The "twice the inner ring" rule of thumb is only a rule of thumb; the real
  // limit was measured by walking NEAR_DAY_RING down and watching the margin by
  // which each event beats the next day to its own day.
  //
  // Two things move that break point, and both had to move to get here:
  //   - TODAY_LINK_WEIGHT, which sets how fat today's cluster is. At 4 the
  //     margin went negative around 155; at 5 it is still +21px at 150.
  //   - FAR_DAY_RING, which is not independent of it. The break point measured
  //     at 145 when FAR was 290 came back up to ~157 once FAR was pulled in to
  //     230, because the rings in between close up with it. A break point is
  //     only valid for the other constants it was measured with.
  // 160 is measured to keep the margin at 23-86px across six fixtures.
  //
  // FAR is not free either: the "rim reads as a different distance" test wants
  // FAR / NEAR > 1.5, which is why the pair is 160/242 and not a rounder 160/240
  // (exactly 1.5, and the test asks for strictly more).
  //
  // The lesson from the measurement: the first ring is not held by its own
  // value but by how fat today's cluster is. Tightening today buys ring room
  // at a better rate than shrinking the rings does.
  var NEAR_DAY_RING = 160;   // a gap of one day
  var FAR_DAY_RING = 242;    // the widest gap the window holds

  // How far beyond its own day a day's events and tasks sit, and how wide a
  // sector they fan across (radians either side of the day's own direction).
  // The gap has to clear the day-to-day ring spacing ((242-160)/5 = 16px) by
  // enough that a cluster reads as belonging to its day rather than to the next
  // ring out; the sector has to stay well inside the 60° each day owns. Rings
  // are 60° apart, so a cluster is never on the same bearing as another ring —
  // measured, the nearest day node to any event is always its own, by 17.7px at
  // the thinnest (a today holding 20 events).
  //
  // Shrinking this does not shrink today's cluster, which hangs off
  // TODAY_LINK_WEIGHT instead: it only pulls the other days' events in, so it
  // buys compaction at the rim without costing headroom at the centre.
  var DAY_CHILD_GAP = 70;
  var DAY_CHILD_SPREAD = 0.35;                          // ~20°
  var DAY_CHILD_WEIGHT = LINK_DISTANCE / DAY_CHILD_GAP;

  // How far an event, task or note may drift from its anchor before anything
  // pulls it back ("予定は現状の距離感を保ち、ある程度範囲で自由に動いて").
  // Inside this radius the force layer applies no anchor force at all, so the
  // node is placed by repulsion and its springs alone; the anchor only catches
  // it at the rim. The point is to keep the arrangement — which ring, which
  // day's direction — while losing the drilled-rank look of every cluster
  // sitting on an exact computed point.
  //
  // Only the day children get it. Day nodes keep their anchors hard: they are
  // the frame the picture is read against, and a wandering day would move the
  // ring its own events are measured from. Today is pinned and has no anchor.
  //
  // The size is bounded by the condition it is most likely to break: every
  // event must still be nearest to its own day node. A node free to move
  // `slack` in any direction can gain up to `slack` of distance to its own day
  // while losing up to `slack` to a rival, so in the worst direction it could
  // spend 2 * slack of that margin. Measured before this change, the thinnest
  // margin across the fixtures was 35.2px (a today holding 8 events, 8 notes
  // and 4 tasks), which caps slack at ~17px if the worst direction actually
  // happened. It does not — repulsion pushes a crowded node outward, away from
  // the rival day rather than at it — so the measured cost at 16 is about 11px,
  // not 32: after the rings were tightened again the thinnest margin lands at
  // 17.7px, still positive across all six fixtures.
  //
  // 16 is also under a quarter of DAY_CHILD_GAP (70), which is the other half
  // of the bound: a cluster may loosen, but it cannot drift back inside its own
  // day's ring, and it cannot reach the ring beyond.
  //
  // Sweeping it (8/12/16/20/24/30/40) keeps condition 3 at 100% throughout, so
  // this is a choice about how loose the picture should look rather than a
  // cliff edge. 16 roughly doubles how far a node sits from its anchor (mean
  // 12-22px before, 24-32px after) while leaving each event's distance to its
  // own day within 4.5% of what it was — the "距離感は保ったまま遊びを持たせる"
  // the user asked for.
  var ANCHOR_SLACK = 16;

  // Radius for a day `gap` days from today, in a window whose widest gap is
  // `span`: linear from NEAR_DAY_RING to FAR_DAY_RING, so every step out is the
  // same step further away.
  function dayRing(gap, span) {
    return span > 1
      ? NEAR_DAY_RING + (FAR_DAY_RING - NEAR_DAY_RING) * (gap - 1) / (span - 1)
      : NEAR_DAY_RING;
  }

  // The spring that holds a day at its ring: rest length = the ring's radius, so
  // the link is already satisfied where the anchor wants the day to be.
  function dayLinkWeight(gap, span) {
    return LINK_DISTANCE / dayRing(gap, span);
  }

  function polar(r, a) { return { x: r * Math.cos(a), y: r * Math.sin(a) }; }

  // How big today's day node is drawn. nodeRadius clamps at 14, so today would
  // otherwise be indistinguishable from any well-connected node; the user asked
  // for it to read as the centre at a glance ("今日の日付を紫で大きくして").
  var TODAY_RADIUS = 18;

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
    var windowKeys = [];
    for (var i = 0; start && i < days; i++) windowKeys.push(addDays(start, i));
    var inWindow = new Set(windowKeys);

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

    // ── today -> each other day in the window ───────────────────────────────
    // A star, never a chain: every edge starts at today, and no two other days
    // are ever linked to each other. A chain (17-18-19-20) would let the far
    // end of the week wander off on its own thread; a star makes the distance
    // from the centre mean one thing only — how many days away it is.
    //
    // The weight falls as the gap grows, so the rest length grows with it and
    // the days settle into rings. Weights below 1 are intended here: a distant
    // day is held by a long, slack spring, which is exactly "less related".
    var todayIdx = today ? windowKeys.indexOf(today) : -1;
    var span = windowKeys.length - 1;                // the widest gap on show
    // The other days, in window order. Their position in this list is the
    // sector they get; their gap from today is the ring they get.
    var others = [];
    if (todayIdx >= 0) {
      windowKeys.forEach(function (key, idx) {
        if (idx === todayIdx) return;                // no self-loop on today
        others.push({ key: key, gap: Math.abs(idx - todayIdx) });
      });
      others.forEach(function (d) {
        link('date:' + today, 'date:' + d.key, dayLinkWeight(d.gap, span));
      });
    }

    // Rest length for an event or task hanging off `key`. Without a today on
    // screen there are no rings, so nothing is gathered and every link is
    // ordinary — the same clock-independence the pin and the star have.
    function childWeight(key) {
      if (todayIdx < 0) return 1;
      return key === today ? TODAY_LINK_WEIGHT : DAY_CHILD_WEIGHT;
    }

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
        // Today's events hug their day; another day's are held at the gap its
        // anchor ring asks for, so the spring agrees with the anchor instead of
        // pulling the cluster back to the default 250. The category edge stays
        // weight 1 on purpose: pulling the category in too would drag along
        // every other day's events that share it, and smear the cluster out.
        link(id, dateId, childWeight(key));
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
      link(id, dateId, childWeight(t.dueDate));
    });

    // ── category nodes ──────────────────────────────────────────────────────
    // Only categories something in the window actually points at. An unused
    // category would float alone and say nothing.
    categories.forEach(function (c) {
      if (!usedCats.has(c.id)) return;
      add({ id: 'cat:' + c.id, kind: 'cat', label: c.name, color: c.color, ref: c, degree: 0 });
    });

    // ── anchors: the world point each node belongs at ───────────────────────
    // Done in one pass at the end, because a day's sector has to be shared out
    // among its events and tasks and none of them exist until now.
    //
    // Today itself gets none — it is pinned, which the force layer honours over
    // everything. Categories get none either: a category belongs to whichever
    // days happen to use it, so pinning it to one sector would be a lie. It is
    // left to its links, which is exactly the "somewhere in the middle of the
    // days I serve" the physics already produces.
    if (todayIdx >= 0) {
      // Every event and task sits with its own day; a note hangs off one of
      // today's events, so it joins today's ring. Insertion order (events, then
      // tasks, then notes) decides who gets which slot — deterministic, so the
      // same data lays out the same way every run.
      var kids = new Map();
      windowKeys.forEach(function (key) { kids.set(key, []); });
      nodes.forEach(function (n) {
        if (n.kind === 'note') kids.get(today).push(n);
        else if ((n.kind === 'event' || n.kind === 'task') && kids.has(n.key)) kids.get(n.key).push(n);
      });

      // Today's own ring: a full circle, since nothing else is inside it to
      // collide with.
      var mine = kids.get(today);
      mine.forEach(function (n, i) {
        n.anchor = polar(TODAY_RING, ANGLE_START + TAU * i / mine.length);
        n.anchorSlack = ANCHOR_SLACK;
      });

      // Each other day owns a ring and an equal slice of the circle, and its
      // events and tasks fan out one step beyond it inside that slice — so they
      // read as radiating outward from their day, away from the centre.
      others.forEach(function (d, slot) {
        var r = dayRing(d.gap, span);
        var a = ANGLE_START + TAU * slot / others.length;
        byId.get('date:' + d.key).anchor = polar(r, a);
        var list = kids.get(d.key);
        list.forEach(function (n, i) {
          var off = list.length > 1 ? DAY_CHILD_SPREAD * (2 * i / (list.length - 1) - 1) : 0;
          n.anchor = polar(r + DAY_CHILD_GAP, a + off);
          n.anchorSlack = ANCHOR_SLACK;
        });
      });
    }

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
    // Today is sized by what it is, not by how many links it happens to have:
    // nodeRadius clamps at 14 and today's six day edges alone would push it
    // there, leaving it the same size as any busy category. Applied after the
    // degree pass so it is the last word.
    nodes.forEach(function (n) { if (n.pinned) n.r = TODAY_RADIUS; });

    return { nodes: nodes, edges: edges, adj: adj };
  }

  var api = {
    buildGraph: buildGraph,
    nodeRadius: nodeRadius,
    hitTest: hitTest,
    WINDOW_DAYS: WINDOW_DAYS,
    TODAY_RADIUS: TODAY_RADIUS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.graphModel = api;

})(typeof window !== 'undefined' ? window : globalThis);
