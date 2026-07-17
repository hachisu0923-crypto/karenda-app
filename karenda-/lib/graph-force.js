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

  // Phyllotaxis, the sunflower spiral d3 uses for initial placement.
  // Deterministic on purpose: no seeded RNG to carry around, and the same
  // input lays out the same way every run, which is what makes it testable.
  function initLayout(nodes) {
    var PHI = Math.PI * (3 - Math.sqrt(5));
    nodes.forEach(function (n, i) {
      var a = i * PHI;
      var r = 10 * Math.sqrt(i);
      n.x = r * Math.cos(a);
      n.y = r * Math.sin(a);
      n.vx = 0;
      n.vy = 0;
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
    var links = graph.edges
      .map(function (e) { return { s: index.get(e.source), t: index.get(e.target) }; })
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
        // Coincident nodes would divide by zero; nudge them apart
        // deterministically (by index, not at random) so they separate.
        if (d2 < 1e-6) { dx = (i - j) * 1e-3; dy = (j - i) * 1e-3; d2 = dx * dx + dy * dy; }
        d = Math.sqrt(d2);
        f = (o.repelStrength * 100 * alpha) / d2;
        var rx = (dx / d) * f, ry = (dy / d) * f;
        a.vx -= rx; a.vy -= ry;
        b.vx += rx; b.vy += ry;
      }
    }

    // Links — a spring pulling toward linkDistance.
    for (i = 0; i < links.length; i++) {
      a = nodes[links[i].s];
      b = nodes[links[i].t];
      dx = b.x - a.x;
      dy = b.y - a.y;
      d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      f = ((d - o.linkDistance) / d) * alpha * o.linkStrength * 0.1;
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

    // Integrate. A node being dragged is pinned: it takes the pointer's
    // position and contributes forces, but never moves on its own.
    for (i = 0; i < n; i++) {
      a = nodes[i];
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
  function fitToView(nodes, w, h, pad) {
    var p = pad == null ? 40 : pad;
    if (!nodes.length) return { zoom: 1, tx: w / 2, ty: h / 2 };
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    });
    var gw = Math.max(1, maxX - minX), gh = Math.max(1, maxY - minY);
    var zoom = clampZoom(Math.min((w - p * 2) / gw, (h - p * 2) / gh));
    return {
      zoom: zoom,
      tx: w / 2 - ((minX + maxX) / 2) * zoom,
      ty: h / 2 - ((minY + maxY) / 2) * zoom,
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
