'use strict';
// Tests for the graph view's model — which nodes exist and what links them.
// Run: node --test tests/graph-model.test.js
// (all: node --test tests/*.test.js — a bare tests/ is resolved as a module and fails)
//
// The graph is scoped to a window of days (the app passes today and 7), not to a
// month. Every test below fixes the window explicitly rather than deriving it
// from the clock: a model that read new Date() must fail here, not next week.
const test = require('node:test');
const assert = require('node:assert');
const { buildGraph, nodeRadius, hitTest, WINDOW_DAYS, TODAY_RADIUS } = require('../karenda-/lib/graph-model.js');

const CATS = [
  { id: 'c1', name: '仕事', color: '#4772b3' },
  { id: 's1', name: 'バイト', color: '#e9973f', type: 'shift', hourlyWage: 1200 },
  { id: 'c9', name: '使われないカテゴリ', color: '#888888' },
];
const k = d => `2026-07-${String(d).padStart(2, '0')}`;
const START = k(17);                         // the window used by most tests: 7/17–7/23
const IN = k(18);                            // a day inside it that is not the start
const build = o => buildGraph(Object.assign(
  { start: START, days: 7, categories: CATS, events: {}, tasks: [] }, o));
const ids = g => g.nodes.map(n => n.id);
const kindOf = (g, kind) => g.nodes.filter(n => n.kind === kind);
const dayKeys = g => kindOf(g, 'date').map(n => n.key);
const edge = (g, a, b) => g.edges.find(e => (e.source === a && e.target === b) || (e.source === b && e.target === a));

// ── the window itself ────────────────────────────────────────────────────────
// "その日から7日以内の予定だけを表示して" — today plus the six days after it.

test('the window is exactly `days` consecutive days starting at start', () => {
  const g = build({});
  assert.deepStrictEqual(dayKeys(g),
    [k(17), k(18), k(19), k(20), k(21), k(22), k(23)],
    `a 7-day window from ${START} must run to ${k(23)}; got [${dayKeys(g).join(', ')}]`);
});

test('every day in the window becomes a node, including empty ones', () => {
  // An empty day is information (it is a gap). Dropping it would make the week
  // look busier than it is.
  const g = build({ events: { [IN]: [{ _dbId: 1, catId: 'c1', title: 'A' }] } });
  assert.strictEqual(kindOf(g, 'date').length, 7,
    `six empty days must still be nodes; got ${kindOf(g, 'date').length}`);
});

test('days defaults to 7 when the caller omits it', () => {
  const g = buildGraph({ start: START, categories: CATS, events: {}, tasks: [] });
  assert.strictEqual(kindOf(g, 'date').length, 7, `the default window is a week, got ${kindOf(g, 'date').length}`);
  assert.strictEqual(WINDOW_DAYS, 7, `WINDOW_DAYS must be the same 7 the app passes, got ${WINDOW_DAYS}`);
});

test('a window that crosses into the next month stays consecutive', () => {
  // The month scope this replaced could not do this. Events and tasks are held
  // for all time with no date filter, so August's records are already to hand.
  const g = buildGraph({ start: '2026-07-28', days: 7, categories: CATS, events: {}, tasks: [] });
  assert.deepStrictEqual(dayKeys(g),
    ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03'],
    `7/28 + 7 days must roll over into August; got [${dayKeys(g).join(', ')}]`);
});

test('a window crossing the end of a leap February runs through the 29th', () => {
  const g = buildGraph({ start: '2024-02-26', days: 7, categories: CATS, events: {}, tasks: [] });
  assert.deepStrictEqual(dayKeys(g),
    ['2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03'],
    `2024 is a leap year, so 2/29 must be in the window; got [${dayKeys(g).join(', ')}]`);
});

test('a window crossing the end of a common February skips from the 28th to March', () => {
  const g = buildGraph({ start: '2026-02-26', days: 7, categories: CATS, events: {}, tasks: [] });
  assert.deepStrictEqual(dayKeys(g),
    ['2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'],
    `2026 is not a leap year, so there must be no 2/29; got [${dayKeys(g).join(', ')}]`);
});

test('a window crossing a year end rolls the year over', () => {
  const g = buildGraph({ start: '2026-12-29', days: 7, categories: CATS, events: {}, tasks: [] });
  assert.deepStrictEqual(dayKeys(g),
    ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04'],
    `the window must continue into 2027; got [${dayKeys(g).join(', ')}]`);
});

test('a day node is labelled with its day of the month, restarting at 1 mid-window', () => {
  const g = buildGraph({ start: '2026-07-30', days: 3, categories: CATS, events: {}, tasks: [] });
  assert.deepStrictEqual(kindOf(g, 'date').map(n => n.label), ['30', '31', '1'],
    'the label is the day of the month, as the month grid writes it');
});

// ── events ───────────────────────────────────────────────────────────────────

test('an event links to its day and its category', () => {
  const g = build({ events: { [IN]: [{ _dbId: 1, catId: 'c1', title: '定例' }] } });
  const e = g.nodes.find(n => n.id === 'event:1');
  assert.strictEqual(e.label, '定例');
  assert.strictEqual(e.color, '#4772b3');
  assert.deepStrictEqual([...g.adj.get('event:1')].sort(), ['cat:c1', 'date:2026-07-18']);
});

test('a shift is labelled with its category name, since its title is empty', () => {
  // app.js does the same fallback in the month cell: ev.title || cat.name
  const g = build({ events: { [IN]: [{ _dbId: 2, catId: 's1', title: '', shiftStart: '17:00' }] } });
  assert.strictEqual(g.nodes.find(n => n.id === 'event:2').label, 'バイト');
});

test('an event with an unknown catId does not throw and gets no colour', () => {
  const g = build({ events: { [IN]: [{ _dbId: 3, catId: 'nope', title: 'X' }] } });
  const e = g.nodes.find(n => n.id === 'event:3');
  assert.strictEqual(e.color, null, 'the view picks a fallback; the model must not invent one');
  assert.deepStrictEqual([...g.adj.get('event:3')], ['date:2026-07-18'], 'no category edge');
});

test('an event with no title and no category still gets a label', () => {
  const g = build({ events: { [IN]: [{ _dbId: 4, catId: 'nope', title: '' }] } });
  assert.strictEqual(g.nodes.find(n => n.id === 'event:4').label, '(無題)');
});

test('an event on the day before the window is ignored', () => {
  const g = build({ events: { [k(16)]: [{ _dbId: 5, catId: 'c1', title: '昨日' }] } });
  assert.strictEqual(kindOf(g, 'event').length, 0,
    `${k(16)} is one day before ${START} and must not appear`);
});

test('an event on the day after the window is ignored', () => {
  const g = build({ events: { [k(24)]: [{ _dbId: 6, catId: 'c1', title: '来週' }] } });
  assert.strictEqual(kindOf(g, 'event').length, 0,
    `${k(24)} is start+7 and must not appear; the window ends at ${k(23)}`);
});

test('an event on the last day of the window is kept', () => {
  // The boundary the test above guards from the other side: start+days-1 is in.
  const g = build({ events: { [k(23)]: [{ _dbId: 7, catId: 'c1', title: '最終日' }] } });
  assert.deepStrictEqual([...g.adj.get('event:7')].sort(), ['cat:c1', 'date:2026-07-23']);
});

test('an event in the next month is kept when the window reaches it', () => {
  // The month scope dropped this one. It is the whole point of the change.
  const g = buildGraph({
    start: '2026-07-28', days: 7, categories: CATS, tasks: [],
    events: { '2026-08-03': [{ _dbId: 8, catId: 'c1', title: '来月' }] },
  });
  assert.deepStrictEqual([...g.adj.get('event:8')].sort(), ['cat:c1', 'date:2026-08-03'],
    'August 3rd is inside a window that starts on July 28th');
});

test('a wikilink in a title is flattened for canvas text', () => {
  const g = build({ events: { [IN]: [{ _dbId: 9, catId: 'c1', title: '[[バイト先|現場]] と打合せ' }] } });
  assert.strictEqual(g.nodes.find(n => n.id === 'event:9').label, '現場 と打合せ');
});

test('an event without a _dbId still gets a unique id', () => {
  const g = build({ events: { [IN]: [{ catId: 'c1', title: 'A' }, { catId: 'c1', title: 'B' }] } });
  const evs = kindOf(g, 'event');
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(new Set(evs.map(n => n.id)).size, 2, 'ids must not collide');
});

// ── tasks ────────────────────────────────────────────────────────────────────

test('an open task due inside the window links to that day', () => {
  const g = build({ tasks: [{ id: 't1', title: '請求書', dueDate: k(20), done: false }] });
  assert.deepStrictEqual([...g.adj.get('task:t1')], ['date:2026-07-20']);
});

test('a task with no due date is left out entirely', () => {
  // dueDate is '' when the field was left blank (app.js). It falls on no day at
  // all, and the graph is scoped to days.
  const g = build({ tasks: [{ id: 't2', title: 'いつか', dueDate: '', done: false }] });
  assert.strictEqual(kindOf(g, 'task').length, 0);
});

test('a completed task is left out, as the month grid does', () => {
  const g = build({ tasks: [{ id: 't3', title: '済み', dueDate: k(20), done: true }] });
  assert.strictEqual(kindOf(g, 'task').length, 0);
});

test('a task due after the window is left out', () => {
  const g = build({ tasks: [{ id: 't4', title: '再来週', dueDate: k(24), done: false }] });
  assert.strictEqual(kindOf(g, 'task').length, 0, `${k(24)} is past the last day ${k(23)}`);
});

test('a task due before the window is left out', () => {
  // Overdue work is not what the user asked to see; the window starts at today.
  const g = build({ tasks: [{ id: 't5', title: '期限切れ', dueDate: k(16), done: false }] });
  assert.strictEqual(kindOf(g, 'task').length, 0, `${k(16)} is before the start ${START}`);
});

test('a task due on the last day of the window is kept', () => {
  const g = build({ tasks: [{ id: 't6', title: '最終日', dueDate: k(23), done: false }] });
  assert.deepStrictEqual([...g.adj.get('task:t6')], ['date:2026-07-23']);
});

test('a task due on a date that does not exist is left out, not dangling', () => {
  // September has 30 days, so 2026-09-31 names no day. It must not hang off a
  // day node that was never built.
  const g = buildGraph({
    start: '2026-09-28', days: 7, categories: CATS, events: {},
    tasks: [{ id: 't7', title: 'X', dueDate: '2026-09-31', done: false }],
  });
  assert.strictEqual(kindOf(g, 'task').length, 0, '2026-09-31 is not a real date');
  assert.ok(g.edges.every(e => e.source !== 'task:t7' && e.target !== 'task:t7'),
    'no edge may point at a task that was not created');
});

test('tasks carry no category edge', () => {
  const g = build({ tasks: [{ id: 't8', title: 'X', dueDate: k(20), done: false }] });
  assert.strictEqual(g.nodes.find(n => n.id === 'task:t8').color, undefined,
    'the view colours tasks from its theme');
});

// ── categories ───────────────────────────────────────────────────────────────

test('only categories used inside the window become nodes', () => {
  const g = build({ events: { [IN]: [{ _dbId: 10, catId: 'c1', title: 'A' }] } });
  const cats = kindOf(g, 'cat').map(n => n.id);
  assert.deepStrictEqual(cats, ['cat:c1'], 'c9 is never referenced, s1 has no events');
});

test('a category whose only event is outside the window is left out', () => {
  const g = build({ events: { [k(24)]: [{ _dbId: 11, catId: 'c1', title: '来週' }] } });
  assert.strictEqual(kindOf(g, 'cat').length, 0,
    'an excluded event must not drag its category in');
});

test('a category with no events at all is left out', () => {
  const g = build({});
  assert.strictEqual(kindOf(g, 'cat').length, 0);
});

// ── edges, degree, radius ────────────────────────────────────────────────────

test('day-to-day edges form a star centred on today, never a chain', () => {
  // This replaces an earlier assertion that there were no day-to-day edges at
  // all. Today now links to each other day so the week can settle into rings
  // around it, but the original intent still holds: consecutive days must not
  // be strung together (17-18-19-20), because a chain lets the far end of the
  // week wander off on its own thread instead of standing at a distance that
  // means "six days away".
  const g = build({
    today: START,
    events: { [IN]: [{ _dbId: 12, catId: 'c1', title: 'A' }], [k(19)]: [{ _dbId: 13, catId: 'c1', title: 'B' }] },
  });
  const dayToDay = g.edges.filter(e => e.source.startsWith('date:') && e.target.startsWith('date:'));
  const offCentre = dayToDay.filter(e => e.source !== 'date:' + START && e.target !== 'date:' + START);
  assert.deepStrictEqual(offCentre, [],
    `every day-to-day edge must touch today; these do not: ${JSON.stringify(offCentre)}`);
});

test('degree counts both ends and drives the radius', () => {
  const g = build({
    events: {
      [IN]: [{ _dbId: 14, catId: 'c1', title: 'A' }, { _dbId: 15, catId: 'c1', title: 'B' }],
      [k(19)]: [{ _dbId: 16, catId: 'c1', title: 'C' }],
    },
  });
  assert.strictEqual(g.nodes.find(n => n.id === 'cat:c1').degree, 3, 'three events point at it');
  assert.strictEqual(g.nodes.find(n => n.id === 'date:2026-07-18').degree, 2);
  assert.strictEqual(g.nodes.find(n => n.id === 'event:14').degree, 2, 'its day and its category');
  const cat = g.nodes.find(n => n.id === 'cat:c1');
  const ev = g.nodes.find(n => n.id === 'event:14');
  assert.ok(cat.r > ev.r, 'the hub must be drawn larger');
});

test('every edge points at a node that exists', () => {
  const g = build({
    events: { [IN]: [{ _dbId: 17, catId: 'c1', title: 'A' }, { _dbId: 18, catId: 'nope', title: 'B' }] },
    tasks: [{ id: 't9', title: 'X', dueDate: IN, done: false }],
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

// ── today's pull ─────────────────────────────────────────────────────────────
// A weight tells the force layer to hold a link shorter and stiffer, so today's
// events and tasks gather around today's day node. `today` comes in as a string
// because the model must never read the wall clock — see the test below that
// guards the omitted case.

test("an event on today is linked to its day more heavily than an event on any other day", () => {
  const g = build({
    today: START,
    events: {
      [START]: [{ _dbId: 20, catId: 'c1', title: '今日' }],
      [IN]: [{ _dbId: 21, catId: 'c1', title: '明日' }],
    },
  });
  const todayW = edge(g, 'event:20', 'date:2026-07-17').weight;
  const otherW = edge(g, 'event:21', 'date:2026-07-18').weight;
  const catW = edge(g, 'event:21', 'cat:c1').weight;
  assert.ok(todayW > otherW, `today's day edge must be the heavier one: today ${todayW}, other day ${otherW}`);
  // Another day's events are gathered too — they have to sit just beyond their
  // own day rather than 250px away in any direction — but never as tightly as
  // today's. The default 1 now belongs to the links with no ring to hold: the
  // category edge is the one that must stay ordinary.
  assert.ok(otherW > 1, `another day must gather its own events too, got ${otherW}`);
  assert.strictEqual(catW, 1, `a category edge must keep the default weight, got ${catW}`);
});

test('a task due today is linked to its day more heavily than a task due another day', () => {
  const g = build({
    today: START,
    tasks: [
      { id: 't20', title: '今日締切', dueDate: START, done: false },
      { id: 't21', title: '週末締切', dueDate: k(20), done: false },
    ],
  });
  const todayW = edge(g, 'task:t20', 'date:2026-07-17').weight;
  const otherW = edge(g, 'task:t21', 'date:2026-07-20').weight;
  assert.ok(todayW > otherW, `today's task must be held closer: today ${todayW}, other day ${otherW}`);
  // As with events: another due date gathers its own task to its ring, just not
  // as tightly as today does.
  assert.ok(otherW > 1, `another due date must gather its own task too, got ${otherW}`);
});

test("an event on today keeps the default weight on its category edge", () => {
  // Only the day edge tightens. Pulling the category in as well would drag
  // every other day's events that share it, smearing the cluster back out.
  const g = build({ today: START, events: { [START]: [{ _dbId: 22, catId: 'c1', title: '今日' }] } });
  const dayW = edge(g, 'event:22', 'date:2026-07-17').weight;
  const catW = edge(g, 'event:22', 'cat:c1').weight;
  assert.ok(dayW > 1, `the day edge should have been weighted, got ${dayW}`);
  assert.strictEqual(catW, 1, `the category edge must stay ordinary, got ${catW}`);
});

test('with no today given, every edge carries the same weight', () => {
  // The guard that keeps the rest of this file clock-independent: buildGraph is
  // given a fixed window, so a model that read new Date() would pass this week
  // and fail the next.
  const g = build({
    events: { [START]: [{ _dbId: 23, catId: 'c1', title: 'A' }] },
    tasks: [{ id: 't22', title: 'X', dueDate: START, done: false }],
  });
  const weights = [...new Set(g.edges.map(e => e.weight))];
  assert.deepStrictEqual(weights, [1], `omitting today must weight nothing; saw weights [${weights.join(', ')}]`);
});

test('a today outside the window on screen weights nothing', () => {
  // The app always starts the window at today, but the model must not assume it.
  const g = build({
    today: '2026-08-17',
    events: { [START]: [{ _dbId: 24, catId: 'c1', title: 'A' }] },
    tasks: [{ id: 't23', title: 'X', dueDate: START, done: false }],
  });
  const heavy = g.edges.filter(e => e.weight !== 1);
  assert.deepStrictEqual(heavy, [], `a day outside the window must not pull: ${JSON.stringify(heavy)}`);
});

// ── the other days, ringed by how near they are ──────────────────────────────
// "その日に関係すること次第で近くして" — relatedness is nearness in time, so
// today links out to each other day with a weight that falls as the gap grows.
// A smaller weight is a longer rest length (linkDistance / weight), so the week
// settles into rings: tomorrow innermost, the sixth day out at the rim.

test('today links to every other day in the window exactly once, and never to itself', () => {
  const g = build({ today: START });
  const dayToDay = g.edges.filter(e => e.source.startsWith('date:') && e.target.startsWith('date:'));
  assert.strictEqual(dayToDay.length, 6,
    `a 7-day window has six other days; got ${dayToDay.length} day-to-day edges`);
  const others = dayToDay.map(e => (e.source === 'date:' + START ? e.target : e.source)).sort();
  assert.deepStrictEqual(others,
    [k(18), k(19), k(20), k(21), k(22), k(23)].map(d => 'date:' + d).sort(),
    `each of the other six days must be linked once; got [${others.join(', ')}]`);
  const selfLoop = g.edges.filter(e => e.source === e.target);
  assert.deepStrictEqual(selfLoop, [], `today must not be linked to itself: ${JSON.stringify(selfLoop)}`);
});

test('the day six days out is held on a much weaker spring than tomorrow', () => {
  // The one comparison the whole feature rests on: a bigger gap must mean a
  // smaller weight, which the force layer reads as a longer rest length.
  const g = build({ today: START });
  const near = edge(g, 'date:' + START, 'date:' + k(18)).weight;
  const far = edge(g, 'date:' + START, 'date:' + k(23)).weight;
  assert.ok(far < near,
    `a gap of six days must weigh less than a gap of one: gap 1 is ${near}, gap 6 is ${far}`);
  // "Well outside" is the property under test, not a particular ratio: the
  // rings may be drawn tighter or looser (the user asks for the picture to be
  // more or less compact) as long as the far rim still reads as a different
  // distance from the first ring rather than a thickening of it. Half again as
  // far is the line — a weight is 250/radius, so a ratio of weights is the
  // inverse ratio of radii.
  assert.ok(near / far > 1.5,
    `the rim should sit well outside the first ring: gap 1 is ${near}, gap 6 is ${far}, ratio ${near / far}`);
});

test('the day-to-day weight falls at every step out from today', () => {
  const g = build({ today: START });
  const weights = [18, 19, 20, 21, 22, 23].map(d => edge(g, 'date:' + START, 'date:' + k(d)).weight);
  for (let i = 1; i < weights.length; i++) {
    assert.ok(weights[i] < weights[i - 1],
      `day ${17 + i + 1} must be held further out than day ${17 + i}; weights are [${weights.join(', ')}]`);
  }
});

test("no other day is drawn in closer than today's own events", () => {
  // Tomorrow must sit outside today's cluster. If it came in nearer, the
  // picture would say tomorrow matters more than what today actually holds.
  const g = build({ today: START, events: { [START]: [{ _dbId: 41, catId: 'c1', title: '今日' }] } });
  const cluster = edge(g, 'event:41', 'date:' + START).weight;
  const tomorrow = edge(g, 'date:' + START, 'date:' + k(18)).weight;
  assert.ok(tomorrow < cluster,
    `today's own events must be the innermost ring: event weight ${cluster}, tomorrow ${tomorrow}`);
});

test('with no today given, no two days are linked at all', () => {
  // The same clock-independence guard the weights and the pin have: a model
  // that read new Date() would build a star here and fail this test.
  const g = build({});
  const dayToDay = g.edges.filter(e => e.source.startsWith('date:') && e.target.startsWith('date:'));
  assert.deepStrictEqual(dayToDay, [],
    `omitting today must link no days; got ${JSON.stringify(dayToDay)}`);
});

test('a today outside the window on screen links no days together', () => {
  const g = build({ today: '2026-08-17' });
  const dayToDay = g.edges.filter(e => e.source.startsWith('date:') && e.target.startsWith('date:'));
  assert.deepStrictEqual(dayToDay, [],
    `a day outside the window is not a centre; got ${JSON.stringify(dayToDay)}`);
});

test("today's day node is drawn larger than any radius a degree could earn", () => {
  const g = build({
    today: START,
    events: { [START]: [{ _dbId: 42, catId: 'c1', title: 'A' }], [IN]: [{ _dbId: 43, catId: 'c1', title: 'B' }] },
    tasks: [{ id: 't40', title: 'X', dueDate: START, done: false }],
  });
  const todayNode = g.nodes.find(n => n.id === 'date:' + START);
  const biggestOther = Math.max(...g.nodes.filter(n => n !== todayNode).map(n => n.r));
  assert.strictEqual(todayNode.r, TODAY_RADIUS,
    `today must take the fixed radius, got ${todayNode.r}`);
  assert.ok(todayNode.r > biggestOther,
    `today must be the largest node; today ${todayNode.r}, largest other ${biggestOther}`);
  assert.ok(TODAY_RADIUS > nodeRadius(1000),
    `the fixed radius must clear the degree clamp; ${TODAY_RADIUS} vs ${nodeRadius(1000)}`);
});

// ── today at the centre ──────────────────────────────────────────────────────
// A pinned node is one the force layer holds at the origin, so today sits in
// the middle of the picture and the week arranges itself around it. As with
// the weights above, the model only names which day it is; what pinning means
// is the physics' business.

test("today's day node is pinned and no other day is", () => {
  const g = build({ today: START });
  const pinned = g.nodes.filter(n => n.pinned).map(n => n.id);
  assert.deepStrictEqual(pinned, ['date:2026-07-17'], `exactly today must be pinned; pinned [${pinned.join(', ')}]`);
});

test('an event on today is not pinned — only the day it hangs off is', () => {
  // The events gather around today because their link is weighted, not because
  // they are held anywhere. Pinning them too would stack them all on one point.
  const g = build({
    today: START,
    events: { [START]: [{ _dbId: 25, catId: 'c1', title: '今日' }] },
    tasks: [{ id: 't24', title: '今日締切', dueDate: START, done: false }],
  });
  assert.ok(!g.nodes.find(n => n.id === 'event:25').pinned, "today's event must stay free to move");
  assert.ok(!g.nodes.find(n => n.id === 'task:t24').pinned, "today's task must stay free to move");
});

test('with no today given, no day is pinned', () => {
  // The same clock-independence guard the weights have.
  const g = build({});
  const pinned = g.nodes.filter(n => n.pinned).map(n => n.id);
  assert.deepStrictEqual(pinned, [], `omitting today must pin nothing; pinned [${pinned.join(', ')}]`);
});

test('a today outside the window on screen pins nothing', () => {
  const g = build({ today: '2026-08-17' });
  const pinned = g.nodes.filter(n => n.pinned).map(n => n.id);
  assert.deepStrictEqual(pinned, [], `a day outside the window must not be pinned; pinned [${pinned.join(', ')}]`);
});

// ── notes today's events mention ──────────────────────────────────────────────
// A [[note]] written in today's event title becomes its own node, held near the
// event with the same weight that gathers today's cluster — so the note lands
// near the centre. Only today's events do this: the other six days would spray
// notes across the window. The target (before any '|') is the node; an alias is
// only display text. See buildGraph's event loop.

test("a [[note]] in today's event title becomes a note node held as tightly as today's own cluster", () => {
  const g = build({ today: START, events: { [START]: [{ _dbId: 30, catId: 'c1', title: '打合せ [[案件A]]' }] } });
  const note = g.nodes.find(n => n.id === 'note:案件A');
  assert.ok(note, 'the note the title mentions must become a node');
  assert.strictEqual(note.kind, 'note', `a note node must be kind "note", got ${note && note.kind}`);
  assert.strictEqual(note.label, '案件A', `the label is the note name, got ${note && note.label}`);
  // The property, not the number: a note hangs off today's event on the same
  // spring that holds the event to today, so the note joins today's cluster
  // instead of drifting out to the default 250px. The weight itself moves when
  // the picture is made more or less compact.
  const w = edge(g, 'event:30', 'note:案件A').weight;
  const dayW = edge(g, 'event:30', 'date:' + START).weight;
  assert.strictEqual(w, dayW,
    `the event->note edge must carry the same today weight as the event->day edge, got ${w} vs ${dayW}`);
  assert.ok(w > 1, `a note must be gathered, not left on the default spring, got ${w}`);
});

test("a note node carries no colour, so the view themes it like a task", () => {
  const g = build({ today: START, events: { [START]: [{ _dbId: 31, catId: 'c1', title: '[[案件A]]' }] } });
  const note = g.nodes.find(n => n.id === 'note:案件A');
  assert.strictEqual(note.color, undefined, 'the model must not colour a note; the view decides');
  assert.strictEqual(note.ref, undefined, 'a note has no source record to reference');
});

test("[[note|alias]] keys the node on the target, not the alias", () => {
  const g = build({ today: START, events: { [START]: [{ _dbId: 32, catId: 'c1', title: '[[案件A|あの件]]' }] } });
  assert.ok(g.nodes.find(n => n.id === 'note:案件A'), 'the node is the note (target), got ids ' + JSON.stringify(ids(g).filter(x => x.startsWith('note:'))));
  assert.ok(!g.nodes.find(n => n.id === 'note:あの件'), 'the alias must not become a node');
});

test("two of today's events naming the same note share one node", () => {
  const g = build({
    today: START,
    events: { [START]: [
      { _dbId: 33, catId: 'c1', title: '午前 [[案件A]]' },
      { _dbId: 34, catId: 'c1', title: '午後 [[案件A]]' },
    ] },
  });
  assert.strictEqual(kindOf(g, 'note').length, 1, 'the shared note must not be duplicated');
  assert.strictEqual(g.nodes.find(n => n.id === 'note:案件A').degree, 2, 'both events link to the one note');
});

test("a [[note]] on another day's event does not become a node", () => {
  // Only today's events pull notes in — "本日の予定を中心に" is the whole point.
  const g = build({
    today: START,
    events: {
      [START]: [{ _dbId: 35, catId: 'c1', title: '今日 [[今日ノート]]' }],
      [IN]: [{ _dbId: 36, catId: 'c1', title: '明日 [[明日ノート]]' }],
    },
  });
  assert.ok(g.nodes.find(n => n.id === 'note:今日ノート'), "today's note must be a node");
  assert.ok(!g.nodes.find(n => n.id === 'note:明日ノート'), "another day in the window must not add notes");
  assert.strictEqual(kindOf(g, 'note').length, 1, 'only today contributes notes');
});

test("a today event with no wikilink creates no note node", () => {
  const g = build({ today: START, events: { [START]: [{ _dbId: 37, catId: 'c1', title: 'ただの打合せ' }] } });
  assert.strictEqual(kindOf(g, 'note').length, 0, 'a plain title must not spawn a note');
});

test("with no today given, no note node is created (clock-independence guard)", () => {
  const g = build({ events: { [START]: [{ _dbId: 38, catId: 'c1', title: '[[案件A]]' }] } });
  assert.strictEqual(kindOf(g, 'note').length, 0, 'omitting today must create no notes');
});

test("a note node is not pinned — only today's day is held at the origin", () => {
  const g = build({ today: START, events: { [START]: [{ _dbId: 39, catId: 'c1', title: '[[案件A]]' }] } });
  assert.ok(!g.nodes.find(n => n.id === 'note:案件A').pinned, 'the note must stay free to move');
});

test("a task due today does not pull in the [[notes]] in its title", () => {
  // The user asked for 予定内容 (event content), not task content. Tasks stay out.
  const g = build({ today: START, tasks: [{ id: 't30', title: '[[タスクノート]] 提出', dueDate: START, done: false }] });
  assert.strictEqual(kindOf(g, 'note').length, 0, 'tasks must not spawn note nodes');
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
  assert.doesNotThrow(() => buildGraph({ start: START }));
  const g = buildGraph({ start: START });
  assert.strictEqual(kindOf(g, 'date').length, 7);
});

test('buildGraph with no start at all builds nothing rather than NaN days', () => {
  assert.doesNotThrow(() => buildGraph({}));
  const g = buildGraph({});
  assert.deepStrictEqual(g.nodes, [], `a missing window must produce no nodes; got [${ids(g).join(', ')}]`);
});

test('a malformed date key in events is skipped, not fatal', () => {
  const g = build({ events: { 'garbage': [{ _dbId: 40, catId: 'c1', title: 'X' }] } });
  assert.strictEqual(kindOf(g, 'event').length, 0);
});

// ── anchors: which ring and which direction each node belongs in ──────────────
// The model does not move anything — the force layer does — but it decides
// where everything belongs. These tests read that decision straight off the
// nodes; the settled geometry it produces is measured in graph-force.test.js.

const R = n => Math.hypot(n.anchor.x, n.anchor.y);
const bearing = n => Math.atan2(n.anchor.y, n.anchor.x);
// Smallest angle between two bearings, in radians — the circle wraps, so a
// plain subtraction would call 350° and 10° twenty degrees apart or 340.
const between = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const node = (g, id) => g.nodes.find(n => n.id === id);

test('today itself takes no anchor — it is pinned, which outranks one', () => {
  const g = build({ today: START });
  assert.strictEqual(node(g, 'date:' + START).anchor, undefined,
    'today must be left to the pin, not given a second opinion about where it goes');
});

test('every other day is anchored further out than the day before it', () => {
  const g = build({ today: START });
  const radii = [18, 19, 20, 21, 22, 23].map(d => R(node(g, 'date:' + k(d))));
  for (let i = 1; i < radii.length; i++) {
    assert.ok(radii[i] > radii[i - 1],
      `each step out must be further from today; radii are [${radii.map(r => r.toFixed(1)).join(', ')}]`);
  }
});

test('the other days are anchored on distinct bearings, not stacked on one', () => {
  // The rings alone would let two days sit on the same line out of today, which
  // is what lets clusters mix. Each day owns a sector.
  const g = build({ today: START });
  const days = [18, 19, 20, 21, 22, 23].map(d => node(g, 'date:' + k(d)));
  for (let i = 0; i < days.length; i++) {
    for (let j = i + 1; j < days.length; j++) {
      const apart = between(bearing(days[i]), bearing(days[j]));
      assert.ok(apart > 0.5,
        `${days[i].key} and ${days[j].key} must face different ways, only ${apart.toFixed(3)} rad apart`);
    }
  }
});

test("an event on another day is anchored beyond its own day, not inside it", () => {
  const g = build({ today: START, events: { [k(19)]: [{ _dbId: 60, catId: 'c1', title: 'A' }] } });
  const day = node(g, 'date:' + k(19));
  const ev = node(g, 'event:60');
  assert.ok(R(ev) > R(day),
    `an event must be anchored outside its day: event ${R(ev).toFixed(1)}, day ${R(day).toFixed(1)}`);
});

test("a task on another day is anchored beyond its own day too", () => {
  const g = build({ today: START, tasks: [{ id: 't60', title: 'X', dueDate: k(21), done: false }] });
  const day = node(g, 'date:' + k(21));
  const t = node(g, 'task:t60');
  assert.ok(R(t) > R(day),
    `a task must be anchored outside its day: task ${R(t).toFixed(1)}, day ${R(day).toFixed(1)}`);
});

test("another day's events are anchored in that day's own direction", () => {
  // Outward is only half of it. An event anchored outward but on some other
  // bearing would drift into a neighbour's cluster.
  const g = build({
    today: START,
    events: { [k(20)]: [{ _dbId: 61, catId: 'c1', title: 'A' }, { _dbId: 62, catId: 'c1', title: 'B' }] },
    tasks: [{ id: 't61', title: 'X', dueDate: k(20), done: false }],
  });
  const day = node(g, 'date:' + k(20));
  ['event:61', 'event:62', 'task:t61'].forEach(id => {
    const apart = between(bearing(node(g, id)), bearing(day));
    assert.ok(apart <= 0.36,
      `${id} must sit inside its day's sector, ${apart.toFixed(3)} rad off its day's bearing`);
  });
});

test("several events on one day fan out rather than stacking on one point", () => {
  const g = build({
    today: START,
    events: { [k(22)]: [1, 2, 3, 4].map((n, i) => ({ _dbId: 70 + i, catId: 'c1', title: 'E' + n })) },
  });
  const seen = new Set([70, 71, 72, 73].map(i => node(g, 'event:' + i).anchor.x + ',' + node(g, 'event:' + i).anchor.y));
  assert.strictEqual(seen.size, 4, 'four events on one day must get four different anchors');
});

test("today's own events and tasks are anchored inside every other day's ring", () => {
  // "その日を中心して" — what today holds is the innermost thing on screen
  // apart from today itself.
  const g = build({
    today: START,
    events: { [START]: [{ _dbId: 80, catId: 'c1', title: 'A' }] },
    tasks: [{ id: 't80', title: 'X', dueDate: START, done: false }],
  });
  const nearestDay = Math.min(...[18, 19, 20, 21, 22, 23].map(d => R(node(g, 'date:' + k(d)))));
  ['event:80', 'task:t80'].forEach(id => {
    assert.ok(R(node(g, id)) < nearestDay,
      `${id} is anchored at ${R(node(g, id)).toFixed(1)}, outside the nearest day ring ${nearestDay.toFixed(1)}`);
  });
});

test("the nearest day ring clears twice today's own ring", () => {
  // The margin condition 3 actually rests on. An event of today's at radius rc,
  // on the same bearing as tomorrow, is nearer tomorrow the moment rc > R1 - rc.
  // Repulsion inflates today's ring as today fills up, so the headroom has to be
  // real rather than incidental.
  const g = build({ today: START, events: { [START]: [{ _dbId: 81, catId: 'c1', title: 'A' }] } });
  const inner = R(node(g, 'event:81'));
  const first = Math.min(...[18, 19, 20, 21, 22, 23].map(d => R(node(g, 'date:' + k(d)))));
  assert.ok(first > 2 * inner,
    `the first day ring (${first.toFixed(1)}) must clear twice today's ring (2 x ${inner.toFixed(1)})`);
});

test("a [[note]] joins today's ring, since it hangs off one of today's events", () => {
  const g = build({ today: START, events: { [START]: [{ _dbId: 82, catId: 'c1', title: '[[議事録]] を書く' }] } });
  const note = node(g, 'note:議事録');
  const ev = node(g, 'event:82');
  assert.ok(note.anchor, 'a note must be anchored like the rest of today');
  assert.ok(Math.abs(R(note) - R(ev)) < 1e-9,
    `a note shares today's ring: note ${R(note).toFixed(1)}, event ${R(ev).toFixed(1)}`);
});

test('a category is left unanchored, because it belongs to no single day', () => {
  // Anchoring it into one day's sector would be a lie about a node that serves
  // several. It is left to its links.
  const g = build({
    today: START,
    events: { [START]: [{ _dbId: 83, catId: 'c1', title: 'A' }], [k(20)]: [{ _dbId: 84, catId: 'c1', title: 'B' }] },
  });
  assert.strictEqual(node(g, 'cat:c1').anchor, undefined, 'a category must stay free to sit among the days it serves');
});

test('with no today given, nothing is anchored at all', () => {
  // The same clock-independence guard the pin, the star and the weights have:
  // there are no rings without a centre to ring.
  const g = build({
    events: { [START]: [{ _dbId: 85, catId: 'c1', title: 'A' }] },
    tasks: [{ id: 't85', title: 'X', dueDate: k(19), done: false }],
  });
  const anchored = g.nodes.filter(n => n.anchor);
  assert.deepStrictEqual(anchored.map(n => n.id), [], 'omitting today must anchor nothing');
});

test('a today outside the window on screen anchors nothing', () => {
  const g = build({ today: '2026-08-17', events: { [START]: [{ _dbId: 86, catId: 'c1', title: 'A' }] } });
  const anchored = g.nodes.filter(n => n.anchor);
  assert.deepStrictEqual(anchored.map(n => n.id), [], 'a day outside the window is not a centre');
});

test('every anchor is a finite pair of numbers', () => {
  // A NaN here would spread through the physics to every node in one tick.
  const g = build({
    today: START,
    events: { [START]: [{ _dbId: 87, catId: 'c1', title: 'A [[N]]' }], [k(23)]: [{ _dbId: 88, catId: 'c1', title: 'B' }] },
    tasks: [{ id: 't87', title: 'X', dueDate: k(19), done: false }],
  });
  g.nodes.filter(n => n.anchor).forEach(n => {
    assert.ok(Number.isFinite(n.anchor.x) && Number.isFinite(n.anchor.y),
      `${n.id} has a non-finite anchor: ${JSON.stringify(n.anchor)}`);
  });
});

test('no anchor lands on the origin, where today is pinned', () => {
  // A node anchored at exactly (0, 0) would seed on top of today and trip the
  // coincident-node guard — the same collision that once threw a month's
  // bounding box out to 57,000px.
  const g = build({
    today: START,
    events: { [START]: [{ _dbId: 89, catId: 'c1', title: 'A' }], [k(18)]: [{ _dbId: 90, catId: 'c1', title: 'B' }] },
  });
  g.nodes.filter(n => n.anchor).forEach(n => {
    assert.ok(Math.hypot(n.anchor.x, n.anchor.y) > 1,
      `${n.id} is anchored on top of today at ${JSON.stringify(n.anchor)}`);
  });
});

test('the same input anchors the same way every build', () => {
  const shape = () => build({
    today: START,
    events: { [k(19)]: [{ _dbId: 91, catId: 'c1', title: 'A' }, { _dbId: 92, catId: 'c2', title: 'B' }] },
    tasks: [{ id: 't91', title: 'X', dueDate: k(19), done: false }],
  }).nodes.map(n => n.id + ':' + (n.anchor ? n.anchor.x.toFixed(6) + ',' + n.anchor.y.toFixed(6) : '-')).join('|');
  assert.strictEqual(shape(), shape(), 'the layout policy must be deterministic');
});

// ── how much play each anchor allows ─────────────────────────────────────────
// "予定は現状の距離感を保ち、ある程度範囲で自由に動いて" — an anchor is a dead
// zone rather than a point, and the model decides its radius. The force layer
// only reads `anchorSlack` (graph-force.js); the policy of who gets play, and
// how much, is here.

const slackFixture = () => build({
  today: START,
  events: {
    [START]: [{ _dbId: 200, catId: 'c1', title: '今日 [[メモ]]' }],
    [IN]: [{ _dbId: 201, catId: 'c1', title: '明日' }],
  },
  tasks: [
    { id: 't200', title: '今日の課題', dueDate: START, done: false },
    { id: 't201', title: '明日の課題', dueDate: IN, done: false },
  ],
});

test("every day's events, tasks and notes are given play, today's included", () => {
  const g = slackFixture();
  ['event:200', 'event:201', 'task:t200', 'task:t201', 'note:メモ'].forEach(id => {
    const n = node(g, id);
    assert.ok(n.anchorSlack > 0, `${id} must be free to move within its zone, got ${n.anchorSlack}`);
  });
});

test('a day node is held hard, with no play at all', () => {
  // The days are the frame the picture is read against: distance from the
  // centre means how far away in time, and direction means which day. A day
  // that wandered would move the ring its own events are measured from, so the
  // play stops at the frame.
  const g = slackFixture();
  const days = kindOf(g, 'date').filter(n => n.key !== START);
  assert.ok(days.length, 'sanity: the window must hold days other than today');
  days.forEach(n => {
    assert.ok(n.anchor, `${n.id} must still be anchored`);
    assert.strictEqual(n.anchorSlack, undefined, `${n.id} must be held exactly at its ring`);
  });
});

test('today and a category get no play, because neither is anchored', () => {
  // Today is pinned, which outranks an anchor; a category belongs to whichever
  // days use it. Slack without an anchor would be meaningless, so neither
  // carries one.
  const g = slackFixture();
  [node(g, 'date:' + START), node(g, 'cat:c1')].forEach(n => {
    assert.strictEqual(n.anchor, undefined, `${n.id} must stay unanchored`);
    assert.strictEqual(n.anchorSlack, undefined, `${n.id} must not carry slack either`);
  });
});

test('the play is small next to the gap it sits in, so clusters cannot merge', () => {
  // The bound that keeps the arrangement legible: an event is anchored
  // DAY_CHILD_GAP beyond its own day, so a zone wider than a quarter of that
  // would let a cluster drift back inside its day's ring or out toward the next
  // one. Read off the built graph rather than the constants, so the assertion
  // survives either being retuned.
  const g = slackFixture();
  const ev = node(g, 'event:201');
  const day = node(g, 'date:' + IN);
  const gap = Math.hypot(ev.anchor.x, ev.anchor.y) - Math.hypot(day.anchor.x, day.anchor.y);
  assert.ok(ev.anchorSlack < gap / 3,
    `play ${ev.anchorSlack} must stay well inside the ${gap.toFixed(1)}px it is anchored beyond its day`);
});

test('every node given play is given an anchor to have play around', () => {
  const g = build({
    today: START,
    events: { [k(19)]: [{ _dbId: 210, catId: 'c1', title: 'A' }, { _dbId: 211, catId: 's1', title: '' }] },
    tasks: [{ id: 't210', title: 'X', dueDate: k(20), done: false }],
  });
  g.nodes.filter(n => n.anchorSlack !== undefined).forEach(n => {
    assert.ok(n.anchor, `${n.id} carries slack but no anchor for it to be slack around`);
    assert.ok(Number.isFinite(n.anchorSlack) && n.anchorSlack > 0,
      `${n.id} has a nonsense slack: ${n.anchorSlack}`);
  });
});

test('the same input gives the same play every build', () => {
  const shape = () => slackFixture().nodes
    .map(n => n.id + ':' + (n.anchorSlack === undefined ? '-' : n.anchorSlack)).join('|');
  assert.strictEqual(shape(), shape(), 'the play policy must be deterministic like the rest');
});
