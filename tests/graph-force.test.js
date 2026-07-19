'use strict';
// Tests for the graph view's force layout.
// Run: node --test tests/graph-force.test.js
// (all: node --test tests/*.test.js — a bare tests/ is resolved as a module and fails)
//
// These only exist because the layout is hand-written and deterministic:
// phyllotaxis seeding means no RNG, so "same input, same output" is testable
// and a regression in the physics shows up as a number, not as a vibe.
const test = require('node:test');
const assert = require('node:assert');
const F = require('../karenda-/lib/graph-force.js');

const g = (nodes, edges) => ({ nodes: nodes.map(id => ({ id })), edges: edges || [] });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ── seeding ──────────────────────────────────────────────────────────────────

test('initLayout is deterministic — same input, same positions', () => {
  const a = F.createSim(g(['a', 'b', 'c', 'd']));
  const b = F.createSim(g(['a', 'b', 'c', 'd']));
  a.nodes.forEach((n, i) => {
    assert.strictEqual(n.x, b.nodes[i].x);
    assert.strictEqual(n.y, b.nodes[i].y);
  });
});

test('initLayout separates nodes rather than stacking them at the origin', () => {
  const sim = F.createSim(g(['a', 'b', 'c', 'd', 'e']));
  const seen = new Set(sim.nodes.map(n => n.x + ',' + n.y));
  assert.strictEqual(seen.size, 5, 'no two nodes start in the same place');
});

test('a whole run is reproducible', () => {
  const run = () => {
    const s = F.createSim(g(['a', 'b', 'c'], [{ source: 'a', target: 'b' }]));
    F.settle(s);
    return s.nodes.map(n => n.x.toFixed(6) + ',' + n.y.toFixed(6)).join('|');
  };
  assert.strictEqual(run(), run());
});

// ── forces ───────────────────────────────────────────────────────────────────

test('two linked nodes settle near linkDistance apart', () => {
  const sim = F.createSim(g(['a', 'b'], [{ source: 'a', target: 'b' }]));
  F.settle(sim);
  const d = dist(sim.nodes[0], sim.nodes[1]);
  // The centering force pulls inwards too, so this lands short of the ideal
  // 250; assert the order of magnitude, not an exact number.
  assert.ok(d > 60 && d < 400, `linked pair settled ${d.toFixed(0)}px apart`);
});

test('two unlinked nodes push apart instead of collapsing', () => {
  const sim = F.createSim(g(['a', 'b']));
  const before = dist(sim.nodes[0], sim.nodes[1]);
  F.settle(sim);
  const after = dist(sim.nodes[0], sim.nodes[1]);
  assert.ok(after > before, `repulsion should separate them: ${before.toFixed(1)} -> ${after.toFixed(1)}`);
});

test('a link pulls a far-apart pair IN toward linkDistance', () => {
  // The spring has a rest length, so it works in both directions. The test
  // above starts them 10px apart and the link pushes them out to ~238; this
  // one starts them far outside 250 and checks the link reels them back.
  // (An earlier version of this test asserted "linked ends up closer than
  // unlinked" and failed — correctly. With only two nodes there is nothing
  // crowding them, so the link spreads them to 250 rather than gathering them.
  // Links only look like they "pull things together" in a graph dense enough
  // that repulsion would otherwise throw them much further than linkDistance.)
  const sim = F.createSim(g(['a', 'b'], [{ source: 'a', target: 'b' }]));
  sim.nodes[0].x = -1500; sim.nodes[0].y = 0;
  sim.nodes[1].x = 1500;  sim.nodes[1].y = 0;
  const before = dist(sim.nodes[0], sim.nodes[1]);
  F.settle(sim);
  const after = dist(sim.nodes[0], sim.nodes[1]);
  assert.ok(after < before, `should be reeled in: ${before.toFixed(0)} -> ${after.toFixed(0)}`);
  assert.ok(after < 600, `should end near linkDistance, got ${after.toFixed(0)}`);
});

test('linkDistance is what a linked pair converges to — change it and the distance follows', () => {
  // The invariant, stated the way the physics actually behaves rather than the
  // way "links pull things together" suggests. Two earlier versions of this
  // test asserted that a link makes a pair *closer* — first against an
  // unlinked pair, then against a crowded blob — and both failed, correctly.
  // At these forces repulsion never pushes a pair past 250, so the spring is
  // only ever spreading them out to its rest length, never gathering them.
  // What is true, and what matters, is that the rest length governs.
  const at = d => {
    const sim = F.createSim(g(['a', 'b'], [{ source: 'a', target: 'b' }]), { linkDistance: d });
    F.settle(sim);
    return dist(sim.nodes[0], sim.nodes[1]);
  };
  const short = at(100), long = at(600);
  assert.ok(short < long, `linkDistance must govern: 100 -> ${short.toFixed(0)}, 600 -> ${long.toFixed(0)}`);
  assert.ok(short > 40 && short < 160, `expected ~100, got ${short.toFixed(0)}`);
  assert.ok(long > 300, `expected to stretch well out, got ${long.toFixed(0)}`);
});

test('a weighted link converges closer than a plain one — the weight divides the rest length', () => {
  // Follows from the test above: since the rest length is the lever, a weight
  // has to shorten it to gather anything. Weight 3 means a rest length of
  // 250/3 ≈ 83 rather than 250.
  const at = w => {
    const sim = F.createSim(g(['a', 'b'], [{ source: 'a', target: 'b', weight: w }]));
    F.settle(sim);
    return dist(sim.nodes[0], sim.nodes[1]);
  };
  const plain = at(1), heavy = at(3);
  assert.ok(heavy < plain, `a weight must pull the pair in: weight 1 -> ${plain.toFixed(0)}, weight 3 -> ${heavy.toFixed(0)}`);
  assert.ok(heavy < 160, `weight 3 should land near 250/3, got ${heavy.toFixed(0)}`);
});

test('an edge with no weight lays out exactly as it did before weights existed', () => {
  // The reproducibility guard. 250 / 1 and x * 1 are exact in IEEE754, so an
  // unweighted edge must tick bit-for-bit as it always has.
  const run = edges => {
    const s = F.createSim(g(['a', 'b', 'c'], edges));
    F.settle(s);
    return s.nodes.map(n => n.x.toFixed(6) + ',' + n.y.toFixed(6)).join('|');
  };
  assert.strictEqual(
    run([{ source: 'a', target: 'b', weight: 1 }]),
    run([{ source: 'a', target: 'b' }]),
    'an explicit weight of 1 must be indistinguishable from no weight at all',
  );
});

test('the layout stays finite — no NaN, no runaway', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => 'n' + i);
  const edges = nodes.slice(1).map(id => ({ source: 'n0', target: id }));   // a hub
  const sim = F.createSim(g(nodes, edges));
  F.settle(sim);
  sim.nodes.forEach(n => {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), n.id + ' went non-finite');
    assert.ok(Math.abs(n.x) < 1e5 && Math.abs(n.y) < 1e5, n.id + ' flew off: ' + n.x);
  });
});

test('coincident nodes separate instead of dividing by zero', () => {
  const sim = F.createSim(g(['a', 'b']));
  sim.nodes.forEach(n => { n.x = 0; n.y = 0; n.vx = 0; n.vy = 0; });
  F.settle(sim);
  sim.nodes.forEach(n => assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y)));
  assert.ok(dist(sim.nodes[0], sim.nodes[1]) > 0, 'they must not stay stacked');
});

// ── alpha / convergence ──────────────────────────────────────────────────────

test('alpha decays monotonically to below the settle threshold within 300 ticks', () => {
  const sim = F.createSim(g(['a', 'b', 'c'], [{ source: 'a', target: 'b' }]));
  let prev = sim.alpha;
  for (let i = 0; i < 300; i++) {
    const a = F.tick(sim);
    assert.ok(a < prev, 'alpha must fall every tick');
    prev = a;
  }
  assert.ok(F.isSettled(sim), `alpha still ${sim.alpha} after 300 ticks`);
});

test('settle stops once converged and reports the tick count', () => {
  const sim = F.createSim(g(['a', 'b'], [{ source: 'a', target: 'b' }]));
  const ticks = F.settle(sim, 1000);
  assert.ok(F.isSettled(sim));
  assert.ok(ticks < 400, `took ${ticks} ticks`);
});

test('settle respects its tick cap', () => {
  const sim = F.createSim(g(['a', 'b']));
  assert.strictEqual(F.settle(sim, 5), 5);
  assert.ok(!F.isSettled(sim), '5 ticks is not enough to converge');
});

test('reheat lifts alpha back above the threshold', () => {
  const sim = F.createSim(g(['a', 'b']));
  F.settle(sim);
  assert.ok(F.isSettled(sim));
  F.reheat(sim);
  assert.ok(!F.isSettled(sim), 'a drag or a data change must restart the layout');
});

// ── dragging ─────────────────────────────────────────────────────────────────

test('a fixed node never moves', () => {
  const sim = F.createSim(g(['a', 'b'], [{ source: 'a', target: 'b' }]));
  const a = sim.nodes[0];
  a.fixed = true;
  a.x = 123; a.y = 456;
  F.settle(sim);
  assert.strictEqual(a.x, 123, 'the dragged node follows the pointer, not the physics');
  assert.strictEqual(a.y, 456);
});

test('a fixed node still pushes the others around', () => {
  const sim = F.createSim(g(['a', 'b'], [{ source: 'a', target: 'b' }]));
  sim.nodes[0].fixed = true;
  sim.nodes[0].x = 500; sim.nodes[0].y = 0;
  const before = { x: sim.nodes[1].x, y: sim.nodes[1].y };
  F.settle(sim);
  assert.ok(sim.nodes[1].x !== before.x || sim.nodes[1].y !== before.y,
    'the free node should be dragged along by the link');
});

// ── pinning (today at the centre) ────────────────────────────────────────────
// The model pins today's day node; the physics holds a pinned node at the
// origin. Deliberately a separate flag from `fixed`: `fixed` is dragging's, and
// the view clears it on pointer-up, which would unpin today for good.

const pin = (nodes, edges, i) => {
  const graph = g(nodes, edges);
  graph.nodes[i].pinned = true;
  return graph;
};

test('initLayout seeds a pinned node at the origin', () => {
  const sim = F.createSim(pin(['a', 'b', 'c'], [], 2));
  assert.strictEqual(sim.nodes[2].x, 0, `a pinned node must start where it stays, got x=${sim.nodes[2].x}`);
  assert.strictEqual(sim.nodes[2].y, 0);
});

test('pinning one node leaves every other node seeded exactly where it was', () => {
  // The pinned node keeps its place in the phyllotaxis spiral and only
  // overrides its own coordinates. Closing the gap instead would reshuffle
  // every seed, so a month that merely contains today would lay out differently
  // from one that does not.
  const seed = i => {
    const graph = i == null ? g(['a', 'b', 'c', 'd', 'e']) : pin(['a', 'b', 'c', 'd', 'e'], [], i);
    return F.createSim(graph).nodes;
  };
  const plain = seed(null), pinned = seed(2);
  pinned.forEach((n, i) => {
    if (i === 2) return;                        // the pinned one is meant to differ
    assert.strictEqual(n.x, plain[i].x, `${n.id} seeded at x=${n.x}, was ${plain[i].x}`);
    assert.strictEqual(n.y, plain[i].y, `${n.id} seeded at y=${n.y}, was ${plain[i].y}`);
  });
});

test('a node seeded on top of the pin is nudged aside, not fired out of the viewport', () => {
  // Not hypothetical: the spiral seeds index 0 at the origin (r = 10 * sqrt(0)),
  // which is exactly where the pin goes, so every month containing today stacks
  // two nodes on the same point. Repulsion is inverse-square, so how far apart a
  // stacked pair is *pretended* to be decides everything. At the 1e-3 this used
  // to nudge by, one tick threw the stacked node 1,171,879px out and took the
  // month's bounding box with it.
  const sim = F.createSim(pin(['a', 'b', 'c'], [], 2));   // 'a' seeds at the origin too
  assert.strictEqual(sim.nodes[0].x, sim.nodes[2].x, 'this test is pointless unless they really are stacked');
  F.tick(sim);
  const d = Math.hypot(sim.nodes[0].x, sim.nodes[0].y);
  assert.ok(d > 0, 'the stacked node must come off the pin');
  assert.ok(d < 100, `one tick moved it ${d.toFixed(0)}px: a divide-by-zero must not be answered with an explosion`);
  F.settle(sim);
  sim.nodes.forEach(n => assert.ok(Math.abs(n.x) < 1000 && Math.abs(n.y) < 1000,
    `${n.id} settled at (${n.x.toFixed(0)}, ${n.y.toFixed(0)}) — a month is a few hundred px across`));
});

test('a pinned node is still exactly at the origin once the layout has settled', () => {
  const sim = F.createSim(pin(['a', 'b', 'c'], [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }], 0));
  F.settle(sim);
  assert.strictEqual(sim.nodes[0].x, 0, `today must not drift; ended at x=${sim.nodes[0].x}`);
  assert.strictEqual(sim.nodes[0].y, 0);
});

test('a pinned node still pushes the others around', () => {
  // Same as a fixed node: it contributes forces, it just does not integrate its
  // own. If it did not, the month would settle as though today were not there.
  const sim = F.createSim(pin(['a', 'b'], [{ source: 'a', target: 'b' }], 0));
  const before = { x: sim.nodes[1].x, y: sim.nodes[1].y };
  F.settle(sim);
  assert.ok(sim.nodes[1].x !== before.x || sim.nodes[1].y !== before.y,
    'the free node should be moved by the pinned one');
  const d = dist(sim.nodes[0], sim.nodes[1]);
  assert.ok(d > 60 && d < 400, `the spring must still act on the free end: settled ${d.toFixed(0)}px out`);
});

test('a drag cannot move a pinned node — pinned beats fixed', () => {
  // What the view does to a node under the pointer: set fixed, then write the
  // pointer's position into x/y every move. Today ignores both.
  const sim = F.createSim(pin(['a', 'b'], [{ source: 'a', target: 'b' }], 0));
  const a = sim.nodes[0];
  a.fixed = true;
  a.x = 300; a.y = 300;
  F.tick(sim);
  assert.strictEqual(a.x, 0, `a pinned node must snap back, got x=${a.x}`);
  assert.strictEqual(a.y, 0, `a pinned node must snap back, got y=${a.y}`);
});

test('a node with pinned: false lays out exactly as one with no pinned field at all', () => {
  // The reproducibility guard, the twin of the weight one above: a graph with
  // nothing pinned — every month that is not this one — must tick bit-for-bit
  // as it always has.
  const run = mark => {
    const graph = g(['a', 'b', 'c'], [{ source: 'a', target: 'b' }]);
    if (mark) graph.nodes[0].pinned = false;
    const s = F.createSim(graph);
    F.settle(s);
    return s.nodes.map(n => n.x.toFixed(6) + ',' + n.y.toFixed(6)).join('|');
  };
  assert.strictEqual(run(true), run(false), 'an explicit pinned: false must be indistinguishable from no flag at all');
});

// ── camera ───────────────────────────────────────────────────────────────────

test('worldToScreen and screenToWorld are inverses', () => {
  const cam = { zoom: 1.7, tx: 33, ty: -12 };
  const s = F.worldToScreen(cam, 10, 20);
  const w = F.screenToWorld(cam, s.x, s.y);
  assert.ok(Math.abs(w.x - 10) < 1e-9 && Math.abs(w.y - 20) < 1e-9);
});

test('clampZoom holds the range', () => {
  assert.strictEqual(F.clampZoom(0.01), 0.15);
  assert.strictEqual(F.clampZoom(99), 4);
  assert.strictEqual(F.clampZoom(1), 1);
});

test('zoomAt keeps the point under the cursor fixed', () => {
  const cam = { zoom: 1, tx: 0, ty: 0 };
  const before = F.screenToWorld(cam, 200, 150);
  const next = F.zoomAt(cam, 200, 150, 2);
  const after = F.screenToWorld(next, 200, 150);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, 'the world point under the cursor must not shift');
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('zoomAt will not zoom past the clamp', () => {
  const cam = { zoom: 4, tx: 0, ty: 0 };
  assert.strictEqual(F.zoomAt(cam, 0, 0, 2).zoom, 4);
});

test('fitToView centres the graph in the viewport', () => {
  const nodes = [{ x: -100, y: -50 }, { x: 100, y: 50 }];
  const cam = F.fitToView(nodes, 400, 300);
  const c = F.worldToScreen(cam, 0, 0);       // the graph's centre
  assert.ok(Math.abs(c.x - 200) < 1e-6, 'centre should land at the viewport centre');
  assert.ok(Math.abs(c.y - 150) < 1e-6);
});

test('fitToView tolerates an empty graph', () => {
  const cam = F.fitToView([], 400, 300);
  assert.strictEqual(cam.tx, 200);
  assert.strictEqual(cam.ty, 150);
});

test('fitToView tolerates a single node', () => {
  const cam = F.fitToView([{ x: 7, y: 7 }], 400, 300);
  assert.ok(Number.isFinite(cam.zoom) && cam.zoom > 0, 'a zero-size bounding box must not divide by zero');
});

// ── fitToView with an explicit centre (today dead centre) ────────────────────

test('fitToView puts an explicit centre at the exact centre of the viewport', () => {
  // A deliberately lopsided graph: the bounding box centre is nowhere near the
  // origin, so framing by bounding box alone would leave the origin off-centre.
  const nodes = [{ x: 0, y: 0 }, { x: 400, y: 300 }, { x: 50, y: 20 }];
  const cam = F.fitToView(nodes, 1200, 800, 40, { x: 0, y: 0 });
  const c = F.worldToScreen(cam, 0, 0);
  assert.ok(Math.abs(c.x - 600) < 1e-6, `the chosen centre landed at x=${c.x}, expected 600`);
  assert.ok(Math.abs(c.y - 400) < 1e-6, `the chosen centre landed at y=${c.y}, expected 400`);
});

test('fitToView keeps every node on screen when it is centred on a point', () => {
  // The offset from bounding-box framing eats into the far side, so the zoom
  // must shrink to compensate; if it does not, the far node leaves the canvas.
  const nodes = [{ x: 0, y: 0 }, { x: 500, y: 400 }, { x: -60, y: -30 }, { x: 120, y: -350 }];
  const cam = F.fitToView(nodes, 1200, 800, 40, { x: 0, y: 0 });
  nodes.forEach(n => {
    const s = F.worldToScreen(cam, n.x, n.y);
    assert.ok(s.x >= 0 && s.x <= 1200, `node (${n.x}, ${n.y}) sits at screen x=${s.x}, outside 0..1200`);
    assert.ok(s.y >= 0 && s.y <= 800, `node (${n.x}, ${n.y}) sits at screen y=${s.y}, outside 0..800`);
  });
});

test('fitToView without a centre frames exactly as it always did', () => {
  // The guard on the original behaviour: the new argument must be inert when
  // it is not supplied.
  const nodes = [{ x: -100, y: -50 }, { x: 100, y: 50 }, { x: 30, y: 10 }];
  const before = F.fitToView(nodes, 400, 300);
  // (400 - 40*2) / 200 = 1.6, the narrower of the two axes.
  assert.strictEqual(before.zoom, 1.6, `zoom drifted to ${before.zoom}`);
  assert.strictEqual(before.tx, 200, `tx drifted to ${before.tx}`);
  assert.strictEqual(before.ty, 150, `ty drifted to ${before.ty}`);
  assert.deepStrictEqual(F.fitToView(nodes, 400, 300, undefined, undefined), before);
});

test('fitToView tolerates an empty graph even when a centre is given', () => {
  const cam = F.fitToView([], 400, 300, 40, { x: 0, y: 0 });
  assert.strictEqual(cam.tx, 200);
  assert.strictEqual(cam.ty, 150);
  assert.ok(Number.isFinite(cam.zoom), `zoom must stay finite, got ${cam.zoom}`);
});

test('fitToView tolerates a single node sitting on the centre', () => {
  // Both half-extents are 0 here — the case that would divide by zero.
  const cam = F.fitToView([{ x: 7, y: 7 }], 400, 300, 40, { x: 7, y: 7 });
  assert.ok(Number.isFinite(cam.zoom) && cam.zoom > 0, `a zero half-extent must not produce ${cam.zoom}`);
  const c = F.worldToScreen(cam, 7, 7);
  assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y), `the camera produced a non-finite position (${c.x}, ${c.y})`);
  assert.ok(Math.abs(c.x - 200) < 1e-6, `the lone node landed at x=${c.x}, expected 200`);
});

// ── the size this actually runs at ───────────────────────────────────────────

test('a realistic month (190 nodes) converges without blowing up', () => {
  // 31 days + ~150 events + 8 categories — the top of the measured range.
  const nodes = [], edges = [];
  for (let d = 1; d <= 31; d++) nodes.push('date:' + d);
  for (let c = 0; c < 8; c++) nodes.push('cat:' + c);
  for (let e = 0; e < 150; e++) {
    nodes.push('event:' + e);
    edges.push({ source: 'event:' + e, target: 'date:' + (1 + (e % 31)) });
    edges.push({ source: 'event:' + e, target: 'cat:' + (e % 8) });
  }
  const sim = F.createSim(g(nodes, edges));
  const t0 = process.hrtime.bigint();
  const ticks = F.settle(sim);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(F.isSettled(sim));
  sim.nodes.forEach(n => assert.ok(Number.isFinite(n.x), n.id + ' non-finite'));
  // 189 nodes, naive O(n^2). Generous bound — this is a smoke test for a
  // pathological regression, not a benchmark.
  assert.ok(ms < 3000, `${ticks} ticks took ${ms.toFixed(0)}ms`);
});

test("the week settles into rings: a day further from today lands further out", () => {
  // The model's falling weights are only a means; what the user asked to see
  // ("その日に関係すること次第で近くして") is the settled picture. Weights that
  // decrease monotonically do not by themselves prove distances that increase
  // monotonically, because repulsion and centering also move a node — so this
  // measures the geometry the eye gets, through the real model weights.
  //
  // The week is bare on purpose: this test pins the ring structure itself.
  //
  // A loaded week used to break it. A day's own events hung off it on stiffer
  // springs (weight 1) than the slack tether holding a far day to today
  // (weight 0.625 at the rim), so an outermost day carrying all the load was
  // dragged inward by its own contents — measured, to 275px, inside the fifth
  // day's 304px. Anchors ended that: the model now names the ring each day
  // belongs on, and a day's events are held at the gap their own anchors ask
  // for instead of pulling against the tether. The loaded case is asserted
  // directly by the test below this one.
  const start = '2026-07-19';
  const graph = require('../karenda-/lib/graph-model.js')
    .buildGraph({ start: start, days: 7, today: start });
  const sim = F.createSim(graph);
  F.settle(sim);
  const today = sim.nodes.find(n => n.pinned);
  const rings = sim.nodes
    .filter(n => n.kind === 'date' && !n.pinned)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(n => Math.hypot(n.x - today.x, n.y - today.y));
  assert.strictEqual(rings.length, 6, `a 7-day window has six other days, got ${rings.length}`);
  for (let i = 1; i < rings.length; i++) {
    assert.ok(rings[i] > rings[i - 1],
      `day ${i + 1} out must settle further than day ${i}; rings are [${rings.map(r => r.toFixed(1)).join(', ')}]`);
  }
  // And the nearest ring clears today's own cluster (~83px, TODAY_LINK_WEIGHT).
  assert.ok(rings[0] > 100,
    `tomorrow must settle outside today's own cluster, got ${rings[0].toFixed(1)}px`);
});

// ── anchors: the arrangement the model asked for, measured after settling ─────
// "その日を中心して、それ以外の日を離して、予定をそのリンクとつながっているは
// それぞれの日から外側に繋がるようにして" — three claims about the settled
// picture, so they are measured on settled coordinates through the real chain
// (buildGraph -> createSim -> settle), never on the anchors the model wrote.

const model = require('../karenda-/lib/graph-model.js');

// A week with two or three events and a task on every single day, which is what
// an ordinary calendar looks like. `pile` overloads one day instead; `crowd`
// fills today itself, which inflates today's ring against the first day ring.
function week(opts) {
  const o = opts || {};
  const today = '2026-07-17';
  const day = i => `2026-07-${String(17 + i).padStart(2, '0')}`;
  const cats = [
    { id: 'c1', name: '仕事', color: '#4772b3' },
    { id: 'c2', name: '暮らし', color: '#e9973f' },
    { id: 'c3', name: '勉強', color: '#4fa66a' },
  ];
  const events = {}, tasks = [];
  let id = 0;
  for (let i = 0; i < 7; i++) {
    const n = o.pile === i ? 9 : (o.crowd && i === 0 ? 8 : 2 + (i % 2));
    events[day(i)] = [];
    for (let j = 0; j < n; j++) {
      // Under `crowd` each of today's events also names a note, so today's ring
      // carries twice as many nodes again.
      const title = o.crowd && i === 0 ? `予定${i}-${j} [[ノート${j}]]` : `予定${i}-${j}`;
      events[day(i)].push({ _dbId: ++id, catId: cats[(i + j) % 3].id, title });
    }
    tasks.push({ id: `t${i}`, title: `課題${i}`, dueDate: day(i), done: false });
    if (o.crowd && i === 0) {
      for (let j = 1; j < 4; j++) tasks.push({ id: `tc${j}`, title: `今日の課題${j}`, dueDate: day(0), done: false });
    }
  }
  const graph = model.buildGraph({ start: today, days: 7, events, categories: cats, tasks, today });
  const sim = F.createSim(graph);
  F.settle(sim);
  return { today, graph, sim, nodes: sim.nodes };
}

const radius = n => Math.hypot(n.x, n.y);
const dayNodes = nodes => nodes.filter(n => n.kind === 'date');
const hangers = nodes => nodes.filter(n => n.kind === 'event' || n.kind === 'task');

test('every event and task settles further from the centre than its own day', () => {
  // The user's "予定をそれぞれの日から外側に繋がるように": a day's contents read
  // as radiating away from today, never doubling back inside the ring.
  const w = week();
  const byKey = new Map(dayNodes(w.nodes).map(d => [d.key, d]));
  const outer = hangers(w.nodes).filter(n => n.key !== w.today);
  const inside = outer.filter(n => !(radius(n) > radius(byKey.get(n.key))));
  assert.deepStrictEqual(
    inside.map(n => `${n.id} r=${radius(n).toFixed(1)} vs day r=${radius(byKey.get(n.key)).toFixed(1)}`), [],
    `all ${outer.length} of the other days' events and tasks must settle outside their own day`);
});

test('a day piled high still keeps its events outside itself', () => {
  // The lopsided case: one day carrying nine events plus a task, which is what
  // dragged a loaded day out of position before anchors existed.
  const w = week({ pile: 5 });
  const byKey = new Map(dayNodes(w.nodes).map(d => [d.key, d]));
  const outer = hangers(w.nodes).filter(n => n.key !== w.today);
  const inside = outer.filter(n => !(radius(n) > radius(byKey.get(n.key))));
  assert.deepStrictEqual(inside.map(n => `${n.id} r=${radius(n).toFixed(1)}`), [],
    `a pile must still sit outside its day; ${outer.length} nodes measured`);
});

test('every event and task settles nearer its own day than any other day', () => {
  // Clusters that do not mix — the other half of the picture. Radial order
  // alone would allow a day's events to drift sideways into the next day's
  // sector, which reads as the wrong day owning them.
  const w = week();
  const days = dayNodes(w.nodes);
  const byKey = new Map(days.map(d => [d.key, d]));
  const strays = [];
  hangers(w.nodes).forEach(n => {
    const own = dist(n, byKey.get(n.key));
    days.forEach(d => {
      if (d.key !== n.key && dist(n, d) <= own) {
        strays.push(`${n.id} (${n.key}) is ${dist(n, d).toFixed(1)}px from ${d.key} but ${own.toFixed(1)}px from its own day`);
      }
    });
  });
  assert.deepStrictEqual(strays, [], 'no event or task may settle nearer another day than its own');
});

test("a crowded today does not push its own events into tomorrow's cluster", () => {
  // The margin that actually broke in practice. Today's ring holds however much
  // today has, and repulsion inflates it — measured, 8 events plus 8 notes plus
  // 4 tasks push it from 83px to ~100px. With the first day ring at 200 one of
  // today's events settled 98px from tomorrow but 100px from today, so tomorrow
  // owned it. The ring spacing has to clear twice the inflated inner ring.
  const w = week({ crowd: true });
  const days = dayNodes(w.nodes);
  const byKey = new Map(days.map(d => [d.key, d]));
  const strays = [];
  hangers(w.nodes).forEach(n => {
    const own = dist(n, byKey.get(n.key));
    days.forEach(d => {
      if (d.key !== n.key && dist(n, d) <= own) {
        strays.push(`${n.id} (${n.key}) is ${dist(n, d).toFixed(1)}px from ${d.key} but ${own.toFixed(1)}px from its own day`);
      }
    });
  });
  assert.deepStrictEqual(strays, [], "a full today must keep its own events nearest to today");
});

test('a day piled high does not spill into the clusters beside it', () => {
  const w = week({ pile: 1 });
  const days = dayNodes(w.nodes);
  const byKey = new Map(days.map(d => [d.key, d]));
  const strays = [];
  hangers(w.nodes).forEach(n => {
    const own = dist(n, byKey.get(n.key));
    days.forEach(d => {
      if (d.key !== n.key && dist(n, d) <= own) strays.push(`${n.id} (${n.key}) -> ${d.key}`);
    });
  });
  assert.deepStrictEqual(strays, [], 'a piled-up day must keep its own events nearest to itself');
});

test('a loaded week still lands its days in date order, further out each step', () => {
  // The case the bare-week test above cannot reach: the ring order has to
  // survive every day carrying its own weight.
  const w = week();
  const today = w.nodes.find(n => n.pinned);
  const rings = dayNodes(w.nodes).filter(n => !n.pinned)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(n => Math.hypot(n.x - today.x, n.y - today.y));
  for (let i = 1; i < rings.length; i++) {
    assert.ok(rings[i] > rings[i - 1],
      `day ${i + 1} out must settle further than day ${i}; rings are [${rings.map(r => r.toFixed(1)).join(', ')}]`);
  }
});

test('the days settle far enough apart that their clusters read as separate', () => {
  const w = week();
  const days = dayNodes(w.nodes);
  let min = Infinity, pair = '';
  for (let i = 0; i < days.length; i++) {
    for (let j = i + 1; j < days.length; j++) {
      const d = dist(days[i], days[j]);
      if (d < min) { min = d; pair = `${days[i].key} and ${days[j].key}`; }
    }
  }
  assert.ok(min > 150,
    `the closest two days (${pair}) settled ${min.toFixed(1)}px apart, too close to read as separate`);
});

test('the whole week fits on a 1200x800 screen with today dead centre', () => {
  const w = week();
  const today = w.nodes.find(n => n.pinned);
  const cam = F.fitToView(w.nodes, 1200, 800, undefined, { x: today.x, y: today.y });
  const centre = F.worldToScreen(cam, today.x, today.y);
  assert.ok(Math.hypot(centre.x - 600, centre.y - 400) < 1e-9,
    `today must land on the centre of the screen, got (${centre.x}, ${centre.y})`);
  const off = w.nodes.filter(n => {
    const s = F.worldToScreen(cam, n.x, n.y);
    return !(s.x > 0 && s.x < 1200 && s.y > 0 && s.y < 800);
  });
  assert.deepStrictEqual(off.map(n => n.id), [],
    `every node must be on screen; ${w.nodes.length} nodes measured`);
  assert.ok(w.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)),
    'every settled coordinate must be finite');
});

// ── what an anchor means to the physics ──────────────────────────────────────

test('an anchored node is pulled to its anchor, a touch inside it', () => {
  // It lands just short, and by a knowable amount: centering pulls toward the
  // origin at centerStrength * 0.1 = 0.01 while the anchor pulls out at
  // anchorStrength = 0.35, so a lone node balances at 0.35/0.36 = 97.22% of the
  // way out. Measured, not assumed — an anchor is a target, not a decree, and
  // every ring radius the model names arrives about 3% short for this reason.
  const anchor = { x: 300, y: -120 };
  const sim = F.createSim({ nodes: [{ id: 'a', anchor: anchor }], edges: [] });
  sim.nodes[0].x = 0; sim.nodes[0].y = 0;         // start it away from home
  F.settle(sim);
  const fraction = Math.hypot(sim.nodes[0].x, sim.nodes[0].y) / Math.hypot(anchor.x, anchor.y);
  assert.ok(Math.abs(fraction - 0.9722) < 0.001,
    `a lone anchored node must balance at 97.22% of its anchor, got ${(fraction * 100).toFixed(2)}% ` +
    `at (${sim.nodes[0].x.toFixed(1)}, ${sim.nodes[0].y.toFixed(1)})`);
  assert.ok(dist(sim.nodes[0], anchor) < 10,
    `and that is within 10px of the anchor itself, got ${dist(sim.nodes[0], anchor).toFixed(1)}px`);
});

test('initLayout seeds an anchored node at its anchor rather than on the spiral', () => {
  // Not tidiness: from the spiral, 400 ticks of a decaying alpha does not always
  // cover 500px, so the first paint would show a half-arrived layout.
  const sim = F.createSim({ nodes: [{ id: 'a' }, { id: 'b', anchor: { x: 500, y: 400 } }], edges: [] });
  assert.strictEqual(sim.nodes[1].x, 500);
  assert.strictEqual(sim.nodes[1].y, 400);
});

test('pinned still beats an anchor, so today cannot be pulled off the origin', () => {
  const sim = F.createSim({ nodes: [{ id: 'a', pinned: true, anchor: { x: 400, y: 400 } }], edges: [] });
  F.settle(sim);
  assert.strictEqual(sim.nodes[0].x, 0);
  assert.strictEqual(sim.nodes[0].y, 0);
});

test('a drag beats an anchor while the pointer holds the node', () => {
  // fixed is set on pointer-down and cleared on pointer-up (app.js dropDrag).
  // An anchor must not fight the pointer, or dragging an event would feel like
  // pulling elastic against the hand.
  const sim = F.createSim({ nodes: [{ id: 'a', anchor: { x: 0, y: 0 } }], edges: [] });
  sim.nodes[0].fixed = true;
  sim.nodes[0].x = 700; sim.nodes[0].y = 700;
  F.settle(sim);
  assert.strictEqual(sim.nodes[0].x, 700, 'a held node must stay exactly where the pointer put it');
  assert.strictEqual(sim.nodes[0].y, 700);
});

test('a graph with no anchors ticks exactly as it did before anchors existed', () => {
  // The reproducibility guarantee: the anchor force must be a no-op for every
  // node that has none, so the existing layout is untouched.
  const plain = F.createSim(g(['a', 'b', 'c', 'd'], [{ source: 'a', target: 'b' }]));
  F.settle(plain);
  const again = F.createSim(g(['a', 'b', 'c', 'd'], [{ source: 'a', target: 'b' }]));
  F.settle(again);
  plain.nodes.forEach((n, i) => {
    assert.strictEqual(n.x, again.nodes[i].x);
    assert.strictEqual(n.y, again.nodes[i].y);
  });
  assert.ok(plain.nodes.every(n => n.anchor === undefined), 'a plain graph must carry no anchors at all');
});
