'use strict';
// Force-directed layout for the graph view. Pure — no DOM, no canvas, no rAF.
// Loaded in the browser as a classic <script> (attaches to window) and required
// by tests/graph-force.test.js in Node (module.exports).
//
// Written by hand rather than pulling d3-force from the CDN, for three reasons:
//   - This is a PWA. sw.js only precaches same-origin files and its fetch is
//     network-first, so a CDN d3 is never cached: offline, the graph tab alone
//     would die while the other six views kept working.
//   - lib/* exists so the browser and node --test run the same implementation
//     (see lib/date-utils.js). A CDN dependency breaks that.
//   - At this size it is a few dozen lines.
//
// No Barnes-Hut quadtree: the month scope tops out near 190 nodes, where the
// naive O(n^2) pass is ~18k pairs per tick — well under a 16.6ms frame. Revisit
// above ~1500 nodes.
(function (root) {

  // Obsidian's own defaults, read out of its app.js (internal constant IJ).
  var DEFAULTS = {
    centerStrength: 0.1,
    repelStrength: 10,
    linkStrength: 1,
    linkDistance: 250,
  };

  var ALPHA_START = 1;
  var ALPHA_MIN = 0.005;      // below this the layout has settled
  var ALPHA_DECAY = 0.0228;   // d3's rate: 1 -> 0.001 in ~300 ticks
  var VELOCITY_DECAY = 0.6;

  // How far apart two nodes at exactly the same point are treated as being (px).
  // It has to be a real distance, not a hair's width: repulsion is inverse
  // square, so pretending a stacked pair is 1e-3px apart answers the division by
  // zero with an impulse of ~1e6. 10 is what initLayout seeds neighbours with,
  // so a stacked pair drifts apart at the rate the spiral would have held them.
  var COINCIDENT_GAP = 10;
  var COINCIDENT_LEG = COINCIDENT_GAP * Math.SQRT1_2;   // its legs, on the diagonal

  // Phyllotaxis, the sunflower spiral d3 uses for initial placement.
  // Deterministic on purpose: no seeded RNG to carry around, and the same
  // input lays out the same way every run, which is what makes it testable.
  //
  // A pinned node starts where it will stay. It keeps its spiral index so every
  // other node seeds exactly where it always has — moving the rest up a slot
  // would change the whole layout of a month that merely contains today.
  function initLayout(nodes) {
    var PHI = Math.PI * (3 - Math.sqrt(5));
    nodes.forEach(function (n, i) {
      var a = i * PHI;
      var r = 10 * Math.sqrt(i);
      n.x = r * Math.cos(a);
      n.y = r * Math.sin(a);
      n.vx = 0;
      n.vy = 0;
      if (n.pinned) { n.x = 0; n.y = 0; }
    });
    return nodes;
  }

  // { nodes, edges } -> a simulation object the caller ticks.
  function createSim(graph, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var nodes = graph.nodes;
    initLayout(nodes);
    var index = new Map();
    nodes.forEach(function (n, i) { index.set(n.id, i); });
    // Resolve ids once so tick() never does a map lookup per edge per frame.
    // The weight rides along: an edge without one is a plain link (w = 1).
    var links = graph.edges
      .map(function (e) {
        return { s: index.get(e.source), t: index.get(e.target), w: (e.weight == null ? 1 : e.weight) };
      })
      .filter(function (l) { return l.s != null && l.t != null; });
    return { nodes: nodes, links: links, alpha: ALPHA_START, opts: o };
  }

  // One step. Mutates node x/y/vx/vy and decays alpha. Returns the new alpha.
  function tick(sim) {
    var nodes = sim.nodes, links = sim.links, o = sim.opts;
    var alpha = sim.alpha;
    var n = nodes.length;
    var i, j, a, b, dx, dy, d2, d, f;

    // Repulsion — every pair pushes apart. The O(n^2) half of the tick.
    for (i = 0; i < n; i++) {
      a = nodes[i];
      for (j = i + 1; j < n; j++) {
        b = nodes[j];
        dx = b.x - a.x;
        dy = b.y - a.y;
        d2 = dx * dx + dy * dy;
        // Coincident nodes would divide by zero; nudge them apart along a fixed
        // diagonal (deterministic, not at random) so they separate. j > i
        // always, so this is the direction the old (i - j) form always took —
        // only the size changed, and only for a pair stacked within 1e-3px,
        // which the spiral never seeds. Any other pair ticks exactly as before.
        //
        // The size mattered the moment today got pinned: the pin lands on the
        // origin, where the spiral seeds its first node too, and the old 1e-3
        // nudge threw that node 1,171,879px out in one tick — the whole month's
        // bounding box went with it.
        if (d2 < 1e-6) { dx = -COINCIDENT_LEG; dy = COINCIDENT_LEG; d2 = COINCIDENT_GAP * COINCIDENT_GAP; }
        d = Math.sqrt(d2);
        f = (o.repelStrength * 100 * alpha) / d2;
        var rx = (dx / d) * f, ry = (dy / d) * f;
        a.vx -= rx; a.vy -= ry;
        b.vx += rx; b.vy += ry;
      }
    }

    // Links — a spring pulling toward its rest length.
    //
    // A weighted link is "shorter and stiffer", which is one idea from two
    // numbers. The rest length is the half that actually gathers nodes: at
    // these forces repulsion never pushes a pair past linkDistance, so a
    // stiffer spring alone would only hold the pair at the same 250 more
    // firmly (see graph-force.test.js, 'linkDistance is what a linked pair
    // converges to'). Dividing the rest length is what brings them in; the
    // matching stiffness is what keeps ~190 nodes of repulsion from prying
    // the cluster back open.
    //
    // w = 1 leaves this arithmetically identical to the unweighted version:
    // x / 1 and x * 1 are exact in IEEE754, so plain links tick bit-for-bit
    // as before and the reproducibility tests still hold.
    for (i = 0; i < links.length; i++) {
      a = nodes[links[i].s];
      b = nodes[links[i].t];
      var w = links[i].w;
      dx = b.x - a.x;
      dy = b.y - a.y;
      d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      var rest = o.linkDistance / w;
      f = ((d - rest) / d) * alpha * o.linkStrength * w * 0.1;
      var lx = dx * f, ly = dy * f;
      a.vx += lx; a.vy += ly;
      b.vx -= lx; b.vy -= ly;
    }

    // Centering — pull everything toward the origin so it cannot drift away.
    for (i = 0; i < n; i++) {
      a = nodes[i];
      a.vx -= a.x * o.centerStrength * alpha * 0.1;
      a.vy -= a.y * o.centerStrength * alpha * 0.1;
    }

    // Integrate. Two kinds of node sit still, and both still push and pull on
    // the others — they just do not integrate their own velocity.
    //
    //   pinned — held at the origin by the model (today). Checked first, so it
    //            wins over a drag: the pointer may set x/y, and the next tick
    //            puts it back. Today is not draggable, by design.
    //   fixed  — being dragged right now; it takes the pointer's position.
    for (i = 0; i < n; i++) {
      a = nodes[i];
      if (a.pinned) { a.x = 0; a.y = 0; a.vx = 0; a.vy = 0; continue; }
      if (a.fixed) { a.vx = 0; a.vy = 0; continue; }
      a.vx *= VELOCITY_DECAY;
      a.vy *= VELOCITY_DECAY;
      a.x += a.vx;
      a.y += a.vy;
    }

    sim.alpha = alpha + (0 - alpha) * ALPHA_DECAY;
    return sim.alpha;
  }

  function isSettled(sim) { return sim.alpha < ALPHA_MIN; }
  function reheat(sim, to) { sim.alpha = to == null ? 0.3 : to; return sim.alpha; }

  // Run to convergence without a frame loop. Used for the first paint and by
  // the tests; the view ticks one frame at a time after that.
  function settle(sim, maxTicks) {
    var max = maxTicks || 400, i = 0;
    while (i < max && !isSettled(sim)) { tick(sim); i++; }
    return i;
  }

  // ── camera ────────────────────────────────────────────────────────────────
  function worldToScreen(cam, wx, wy) {
    return { x: wx * cam.zoom + cam.tx, y: wy * cam.zoom + cam.ty };
  }
  function screenToWorld(cam, sx, sy) {
    return { x: (sx - cam.tx) / cam.zoom, y: (sy - cam.ty) / cam.zoom };
  }
  function clampZoom(z, min, max) {
    return Math.max(min == null ? 0.15 : min, Math.min(max == null ? 4 : max, z));
  }
  // Zoom about a screen point, so whatever is under the cursor stays there.
  function zoomAt(cam, sx, sy, factor, min, max) {
    var z = clampZoom(cam.zoom * factor, min, max);
    var k = z / cam.zoom;
    return { zoom: z, tx: sx - (sx - cam.tx) * k, ty: sy - (sy - cam.ty) * k };
  }
  // Fit the laid-out graph into w x h.
  //
  // `center` (optional) is a world point to put at the exact centre of the
  // screen — the view passes today's node, so today sits dead centre instead of
  // wherever the bounding box happens to put it. Omit it and the framing is the
  // original one: the bounding box's centre goes to the screen's centre.
  //
  // The zoom has to be derived differently in the two cases. Fitting a bounding
  // box only needs its width; holding a chosen point at the centre means the
  // half-screen on each side must cover the *furthest* node from that point, or
  // the offset pushes the far edge off-screen.
  function fitToView(nodes, w, h, pad, center) {
    var p = pad == null ? 40 : pad;
    if (!nodes.length) return { zoom: 1, tx: w / 2, ty: h / 2 };
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    });
    var cx, cy, zoom;
    if (center) {
      cx = center.x;
      cy = center.y;
      // Furthest node from the centre, per axis. Always >= 0, so no sign flip;
      // 0 only when every node shares the centre's coordinate on that axis.
      var halfW = Math.max(cx - minX, maxX - cx);
      var halfH = Math.max(cy - minY, maxY - cy);
      // A zero half-extent constrains nothing — Infinity drops out of the min,
      // and clampZoom caps the all-zero case instead of returning NaN.
      zoom = clampZoom(Math.min(
        halfW > 0 ? (w / 2 - p) / halfW : Infinity,
        halfH > 0 ? (h / 2 - p) / halfH : Infinity
      ));
    } else {
      cx = (minX + maxX) / 2;
      cy = (minY + maxY) / 2;
      var gw = Math.max(1, maxX - minX), gh = Math.max(1, maxY - minY);
      zoom = clampZoom(Math.min((w - p * 2) / gw, (h - p * 2) / gh));
    }
    return {
      zoom: zoom,
      tx: w / 2 - cx * zoom,
      ty: h / 2 - cy * zoom,
    };
  }

  var api = {
    DEFAULTS: DEFAULTS,
    ALPHA_MIN: ALPHA_MIN,
    initLayout: initLayout,
    createSim: createSim,
    tick: tick,
    settle: settle,
    isSettled: isSettled,
    reheat: reheat,
    worldToScreen: worldToScreen,
    screenToWorld: screenToWorld,
    clampZoom: clampZoom,
    zoomAt: zoomAt,
    fitToView: fitToView,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.graphForce = api;

})(typeof window !== 'undefined' ? window : globalThis);
