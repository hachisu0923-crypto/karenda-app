'use strict';
// Tests for the daily-note serializer/parser used by karenda-/app.js.
// Run: node --test tests/md-daily.test.js
// (all: node --test tests/*.test.js — a bare tests/ is resolved as a module and fails)
const test = require('node:test');
const assert = require('node:assert');
const {
  parseTime, normTime, eventToLine, lineToEvent, toDailyNote, fromDailyNote, dateKeyFromNote,
} = require('../karenda-/lib/md-daily.js');

const CATS = { c1: '仕事', s1: 'バイト' };
const catName = id => CATS[id] || '';
const catId = tag => Object.keys(CATS).find(k => CATS[k] === tag) || null;

// ── I8: the bug that import would have walked straight into ──────────────────
// app.js's timeStrToMin did "9".split(':') -> minutes undefined -> 9*60+undefined
// = NaN, which passed its `=== null` guard, so the event rendered at top:NaNpx
// and disappeared. Unreachable from the UI, guaranteed the moment a human types
// "- [ ] 9:00-10:00" in Obsidian. Guard it here, at the parser.

test('parseTime rejects a bare hour with no minutes (the NaN case)', () => {
  assert.strictEqual(parseTime('9'), null);
  assert.strictEqual(parseTime('17'), null);
});

test('parseTime accepts both 9:00 and 09:00', () => {
  assert.deepStrictEqual(parseTime('9:00'), { h: 9, m: 0 });
  assert.deepStrictEqual(parseTime('09:00'), { h: 9, m: 0 });
});

test('parseTime rejects out-of-range and malformed values', () => {
  assert.strictEqual(parseTime('24:00'), null);
  assert.strictEqual(parseTime('12:60'), null);
  assert.strictEqual(parseTime('9:xx'), null);
  assert.strictEqual(parseTime(''), null);
  assert.strictEqual(parseTime(null), null);
});

test('normTime pads a hand-typed 9:00 to 09:00', () => {
  assert.strictEqual(normTime('9:00'), '09:00');
  assert.strictEqual(normTime('9'), '');
});

// ── serialise ────────────────────────────────────────────────────────────────

test('eventToLine writes a clean line with no comment when nothing would be lost', () => {
  const ev = { catId: 'c1', title: '定例ミーティング', time: '09:00', timeEnd: '10:00' };
  assert.strictEqual(eventToLine(ev, catName(ev.catId)), '- [ ] 09:00-10:00 定例ミーティング #仕事');
});

test('eventToLine hides break/overtime/id in a %% %% comment', () => {
  const ev = { _dbId: 412, catId: 's1', title: 'バイト', shiftStart: '17:00', shiftEnd: '22:00', breakMinutes: 60, overtimeMinutes: 30 };
  assert.strictEqual(
    eventToLine(ev, catName(ev.catId)),
    '- [ ] 17:00-22:00 バイト #バイト %%kd id=412 break=60 ot=30 shift=1%%'
  );
});

test('eventToLine omits the time for an all-day event', () => {
  const ev = { catId: 'c1', title: '終日タスク' };
  assert.strictEqual(eventToLine(ev, catName(ev.catId)), '- [ ] 終日タスク #仕事');
});

test('eventToLine turns a category name with spaces into a legal tag', () => {
  const ev = { catId: 'x', title: 'A', time: '09:00' };
  assert.strictEqual(eventToLine(ev, 'side job'), '- [ ] 09:00 A #side_job');
});

test('toDailyNote writes front matter and a 予定 section', () => {
  const note = toDailyNote('2026-07-17', [
    { catId: 'c1', title: '定例', time: '09:00', timeEnd: '10:00' },
  ], catName);
  assert.ok(note.startsWith('---\ndate: 2026-07-17\ntags: [karenda/daily]\n---\n'));
  assert.ok(note.includes('## 予定'));
  assert.ok(note.includes('- [ ] 09:00-10:00 定例 #仕事'));
});

// ── parse ────────────────────────────────────────────────────────────────────

test('lineToEvent reads a clean line', () => {
  const ev = lineToEvent('- [ ] 09:00-10:00 定例ミーティング #仕事', catId);
  assert.strictEqual(ev.title, '定例ミーティング');
  assert.strictEqual(ev.time, '09:00');
  assert.strictEqual(ev.timeEnd, '10:00');
  assert.strictEqual(ev.catId, 'c1');
});

test('lineToEvent normalises a hand-typed 9:00 rather than yielding NaN', () => {
  const ev = lineToEvent('- [ ] 9:00-10:00 手打ち #仕事', catId);
  assert.strictEqual(ev.time, '09:00');
  assert.strictEqual(ev.timeEnd, '10:00');
  assert.ok(!Number.isNaN(Number(ev.time.split(':')[1])));
});

test('lineToEvent treats an unparseable time as part of the title, not as NaN', () => {
  const ev = lineToEvent('- [ ] 9 予定っぽいもの #仕事', catId);
  assert.strictEqual(ev.time, '', 'no bogus time value');
  assert.strictEqual(ev.title, '9 予定っぽいもの');
});

test('lineToEvent recovers break/overtime/id from the comment', () => {
  const ev = lineToEvent('- [ ] 17:00-22:00 バイト #バイト %%kd id=412 break=60 ot=30 shift=1%%', catId);
  assert.strictEqual(ev._dbId, '412');
  assert.strictEqual(ev.breakMinutes, 60);
  assert.strictEqual(ev.overtimeMinutes, 30);
  assert.strictEqual(ev.shiftStart, '17:00');
  assert.strictEqual(ev.shiftEnd, '22:00');
  assert.strictEqual(ev.time, '', 'a shift uses shiftStart, not time');
});

test('lineToEvent reports an unknown tag instead of inventing a category', () => {
  const ev = lineToEvent('- [ ] 09:00 なにか #知らないカテゴリ', catId);
  assert.strictEqual(ev.catId, null);
  assert.strictEqual(ev._tag, '知らないカテゴリ');
});

test('lineToEvent ignores non-task lines', () => {
  assert.strictEqual(lineToEvent('## 予定', catId), null);
  assert.strictEqual(lineToEvent('ただの本文', catId), null);
  assert.strictEqual(lineToEvent('', catId), null);
});

test('lineToEvent records [x] but the app has no done field, so it is only advisory', () => {
  const ev = lineToEvent('- [x] 09:00 済んだ予定 #仕事', catId);
  assert.strictEqual(ev._done, true);
  assert.strictEqual(ev.title, '済んだ予定');
});

test('fromDailyNote reads only the 予定 section', () => {
  const note = [
    '---', 'date: 2026-07-17', '---', '',
    '## 予定', '',
    '- [ ] 09:00-10:00 定例 #仕事',
    '- [ ] 17:00-22:00 バイト #バイト %%kd break=60 shift=1%%',
    '',
    '## メモ',
    '- [ ] これは予定ではない',
  ].join('\n');
  const evs = fromDailyNote(note, catId);
  assert.strictEqual(evs.length, 2, 'the メモ task must not be picked up');
  assert.strictEqual(evs[0].title, '定例');
  assert.strictEqual(evs[1].breakMinutes, 60);
});

test('dateKeyFromNote reads the front matter date', () => {
  assert.strictEqual(dateKeyFromNote('---\ndate: 2026-07-17\ntags: [karenda/daily]\n---\n'), '2026-07-17');
  assert.strictEqual(dateKeyFromNote('no front matter'), '');
});

// ── round trip ───────────────────────────────────────────────────────────────
// The point of the %% %% comment: nothing that affects pay may be lost.

test('round trip preserves a shift including the break that drives the wage', () => {
  const original = [
    { _dbId: '412', catId: 's1', title: 'バイト', time: '', timeEnd: '',
      shiftStart: '17:00', shiftEnd: '22:00', breakMinutes: 60, overtimeMinutes: 30, reminderMinutes: 15 },
  ];
  const back = fromDailyNote(toDailyNote('2026-07-17', original, catName), catId);
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0]._dbId, '412');
  assert.strictEqual(back[0].catId, 's1');
  assert.strictEqual(back[0].title, 'バイト');
  assert.strictEqual(back[0].shiftStart, '17:00');
  assert.strictEqual(back[0].shiftEnd, '22:00');
  assert.strictEqual(back[0].breakMinutes, 60, 'break drives pay — it must survive');
  assert.strictEqual(back[0].overtimeMinutes, 30);
  assert.strictEqual(back[0].reminderMinutes, 15);
});

test('round trip preserves a plain timed event', () => {
  const original = [{ _dbId: '7', catId: 'c1', title: '定例', time: '09:00', timeEnd: '10:00' }];
  const back = fromDailyNote(toDailyNote('2026-07-17', original, catName), catId);
  assert.strictEqual(back[0].title, '定例');
  assert.strictEqual(back[0].time, '09:00');
  assert.strictEqual(back[0].timeEnd, '10:00');
  assert.strictEqual(back[0].catId, 'c1');
});

test('round trip preserves an all-day event', () => {
  const original = [{ catId: 'c1', title: '終日タスク' }];
  const back = fromDailyNote(toDailyNote('2026-07-17', original, catName), catId);
  assert.strictEqual(back[0].title, '終日タスク');
  assert.strictEqual(back[0].time, '');
});
