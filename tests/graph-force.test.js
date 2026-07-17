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
