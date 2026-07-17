'use strict';
// Tests for the graph view's model — which nodes exist and what links them.
// Run: node --test tests/graph-model.test.js
// (all: node --test tests/*.test.js — a bare tests/ is resolved as a module and fails)
const test = require('node:test');
const assert = require('node:assert');
const { buildGraph, nodeRadius, hitTest } = require('../karenda-/lib/graph-model.js');

const CATS = [
  { id: 'c1', name: '仕事', color: '#4772b3' },
  { id: 's1', name: 'バイト', color: '#e9973f', type: 'shift', hourlyWage: 1200 },
  { id: 'c9', name: '使われないカテゴリ', color: '#888888' },
];
const Y = 2026, M = 6;                       // July 2026 (month is 0-based)
const k = d => `2026-07-${String(d).padStart(2, '0')}`;
const build = o => buildGraph(Object.assign({ year: Y, month: M, categories: CATS, events: {}, tasks: [] }, o));
const ids = g => g.nodes.map(n => n.id);
const kindOf = (g, kind) => g.nodes.filter(n => n.kind === kind);

// ── day nodes ────────────────────────────────────────────────────────────────

test('every day of the month becomes a node, including empty ones', () => {
  const g = build({});
  const days = kindOf(g, 'date');
  assert.strictEqual(days.length, 31, 'July has 31 days');
  assert.ok(ids(g).includes('date:2026-07-01'));
  assert.ok(ids(g).includes('date:2026-07-31'));
});

test('February 2024 gets 29 day nodes (leap year)', () => {
  const g = buildGraph({ year: 2024, month: 1, categories: CATS, events: {}, tasks: [] });
  assert.strictEqual(kindOf(g, 'date').length, 29);
});

test('February 2026 gets 28 day nodes', () => {
  const g = buildGraph({ year: 2026, month: 1, categories: CATS, events: {}, tasks: [] });
  assert.strictEqual(kindOf(g, 'date').length, 28);
});

// ── events ───────────────────────────────────────────────────────────────────

test('an event links to its day and its category', () => {
  const g = build({ events: { [k(3)]: [{ _dbId: 1, catId: 'c1', title: '定例' }] } });
  const e = g.nodes.find(n => n.id === 'event:1');
  assert.strictEqual(e.label, '定例');
  assert.strictEqual(e.color, '#4772b3');
  assert.deepStrictEqual([...g.adj.get('event:1')].sort(), ['cat:c1', 'date:2026-07-03']);
});

test('a shift is labelled with its category name, since its title is empty', () => {
  // app.js does the same fallback in the month cell: ev.title || cat.name
  const g = build({ events: { [k(3)]: [{ _dbId: 2, catId: 's1', title: '', shiftStart: '17:00' }] } });
  assert.strictEqual(g.nodes.find(n => n.id === 'event:2').label, 'バイト');
});

test('an event with an unknown catId does not throw and gets no colour', () => {
  const g = build({ events: { [k(3)]: [{ _dbId: 3, catId: 'nope', title: 'X' }] } });
  const e = g.nodes.find(n => n.id === 'event:3');
  assert.strictEqual(e.color, null, 'the view picks a fallback; the model must not invent one');
  assert.deepStrictEqual([...g.adj.get('event:3')], ['date:2026-07-03'], 'no category edge');
});

test('an event with no title and no category still gets a label', () => {
  const g = build({ events: { [k(3)]: [{ _dbId: 4, catId: 'nope', title: '' }] } });
  assert.strictEqual(g.nodes.find(n => n.id === 'event:4').label, '(無題)');
});

test('events from other months are ignored', () => {
  const g = build({ events: { '2026-08-03': [{ _dbId: 5, catId: 'c1', title: '来月' }] } });
  assert.strictEqual(kindOf(g, 'event').length, 0);
});

test('a wikilink in a title is flattened for canvas text', () => {
  const g = build({ events: { [k(3)]: [{ _dbId: 6, catId: 'c1', title: '[[バイト先|現場]] と打合せ' }] } });
  assert.strictEqual(g.nodes.find(n => n.id === 'event:6').label, '現場 と打合せ');
});

test('an event without a _dbId still gets a unique id', () => {
  const g = build({ events: { [k(3)]: [{ catId: 'c1', title: 'A' }, { catId: 'c1', title: 'B' }] } });
  const evs = kindOf(g, 'event');
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(new Set(evs.map(n => n.id)).size, 2, 'ids must not collide');
});

// ── tasks ────────────────────────────────────────────────────────────────────

test('an open task with a due date this month links to that day', () => {
  const g = build({ tasks: [{ id: 't1', title: '請求書', dueDate: k(20), done: false }] });
  assert.deepStrictEqual([...g.adj.get('task:t1')], ['date:2026-07-20']);
});

test('a task with no due date is left out entirely', () => {
  // dueDate is '' when the field was left blank (app.js). It belongs to no
  // month, and the graph is month-scoped.
  const g = build({ tasks: [{ id: 't2', title: 'いつか', dueDate: '', done: false }] });
  assert.strictEqual(kindOf(g, 'task').length, 0);
});

test('a completed task is left out, as the month grid does', () => {
  const g = build({ tasks: [{ id: 't3', title: '済み', dueDate: k(20), done: true }] });
  assert.strictEqual(kindOf(g, 'task').length, 0);
});

test('a task due next month is left out', () => {
  const g = build({ tasks: [{ id: 't4', title: '来月', dueDate: '2026-08-01', done: false }] });
  assert.strictEqual(kindOf(g, 'task').length, 0);
});

test('a task due on a day the month does not have is left out, not dangling', () => {
  // e.g. the 31st while looking at a 30-day month
  const g = buildGraph({ year: 2026, month: 8, categories: CATS, events: {},   // September = 30 days
    tasks: [{ id: 't5', title: 'X', dueDate: '2026-09-31', done: false }] });
  assert.strictEqual(kindOf(g, 'task').length, 0);
  assert.ok(g.edges.every(e => e.source !== 'task:t5' && e.target !== 'task:t5'));
});

test('tasks carry no category edge', () => {
  const g = build({ tasks: [{ id: 't6', title: 'X', dueDate: k(20), done: false }] });
  assert.strictEqual(g.nodes.find(n => n.id === 'task:t6').color, undefined,
    'the view colours tasks from its theme');
});

// ── categories ───────────────────────────────────────────────────────────────

test('only categories used this month become nodes', () => {
  const g = build({ events: { [k(3)]: [{ _dbId: 7, catId: 'c1', title: 'A' }] } });
  const cats = kindOf(g, 'cat').map(n => n.id);
  assert.deepStrictEqual(cats, ['cat:c1'], 'c9 is never referenced, s1 has no events');
});

test('a category with no events this month is left out', () => {
  const g = build({});
  assert.strictEqual(kindOf(g, 'cat').length, 0);
});

// ── edges, degree, radius ────────────────────────────────────────────────────

test('there are exactly three kinds of edge and no day-to-day chain', () => {
  const g = build({
    events: { [k(3)]: [{ _dbId: 8, catId: 'c1', title: 'A' }], [k(4)]: [{ _dbId: 9, catId: 'c1', title: 'B' }] },
  });
  const dayToDay = g.edges.filter(e => e.source.startsWith('date:') && e.target.startsWith('date:'));
  assert.deepStrictEqual(dayToDay, [], 'consecutive days must not be chained');
});

test('degree counts both ends and drives the radius', () => {
  const g = build({
    events: {
      [k(3)]: [{ _dbId: 10, catId: 'c1', title: 'A' }, { _dbId: 11, catId: 'c1', title: 'B' }],
      [k(4)]: [{ _dbId: 12, catId: 'c1', title: 'C' }],
    },
  });
  assert.strictEqual(g.nodes.find(n => n.id === 'cat:c1').degree, 3, 'three events point at it');
  assert.strictEqual(g.nodes.find(n => n.id === 'date:2026-07-03').degree, 2);
  assert.strictEqual(g.nodes.find(n => n.id === 'event:10').degree, 2, 'its day and its category');
  const cat = g.nodes.find(n => n.id === 'cat:c1');
  const ev = g.nodes.find(n => n.id === 'event:10');
  assert.ok(cat.r > ev.r, 'the hub must be drawn larger');
});

test('every edge points at a node that exists', () => {
  const g = build({
    events: { [k(3)]: [{ _dbId: 13, catId: 'c1', title: 'A' }, { _dbId: 14, catId: 'nope', title: 'B' }] },
    tasks: [{ id: 't7', title: 'X', dueDate: k(3), done: false }],
  });
  const have = new Set(g.nodes.map(n => n.id));
  for (const e of g.edges) {
    assert.ok(have.has(e.source), 'dangling source: ' + e.source);
    assert.ok(have.has(e.target), 'dangling target: ' + e.target);
  }
});

test('nodeRadius is clamped and grows with degree', () => {
  assert.strictEqual(nodeRadius(0), 4);
  assert.ok(nodeRadius(4) > nodeRadius(1));
  assert.ok(nodeRadius(1000) <= 14, 'a huge hub must not swallow the canvas');
});

// ── hitTest ──────────────────────────────────────────────────────────────────

test('hitTest returns the node under the point, and null outside', () => {
  const nodes = [{ id: 'a', x: 0, y: 0, r: 10 }, { id: 'b', x: 100, y: 0, r: 10 }];
  assert.strictEqual(hitTest(nodes, 3, 3).id, 'a');
  assert.strictEqual(hitTest(nodes, 100, 5).id, 'b');
  assert.strictEqual(hitTest(nodes, 50, 50), null);
});

test('hitTest prefers the node drawn last where they overlap', () => {
  const nodes = [{ id: 'under', x: 0, y: 0, r: 10 }, { id: 'over', x: 0, y: 0, r: 10 }];
  assert.strictEqual(hitTest(nodes, 0, 0).id, 'over');
});

// ── tolerating junk ──────────────────────────────────────────────────────────

test('buildGraph survives empty and missing inputs', () => {
  assert.doesNotThrow(() => buildGraph({ year: Y, month: M }));
  const g = buildGraph({ year: Y, month: M });
  assert.strictEqual(kindOf(g, 'date').length, 31);
});

test('a malformed date key in events is skipped, not fatal', () => {
  const g = build({ events: { 'garbage': [{ _dbId: 15, catId: 'c1', title: 'X' }] } });
  assert.strictEqual(kindOf(g, 'event').length, 0);
});
