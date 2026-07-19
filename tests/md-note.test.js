'use strict';
// Tests for the individual-note (front matter) writer/reader used by app.js.
// Run: node --test tests/md-note.test.js
// (all: node --test tests/*.test.js — a bare tests/ is resolved as a module and fails)
const test = require('node:test');
const assert = require('node:assert');
const {
  toFrontMatter, parseNote, buildNote,
  budgetToNote, budgetFromNote, taskToNote, taskFromNote, goalToNote, goalFromNote,
  projectToNote,
  safeFileName,
} = require('../karenda-/lib/md-note.js');

const catName = id => ({ food: '食費', salary: '給料' })[id] || '';
const catId = name => Object.keys({ food: '食費', salary: '給料' })
  .find(k => ({ food: '食費', salary: '給料' })[k] === name) || null;

// ── front matter ─────────────────────────────────────────────────────────────

test('toFrontMatter writes scalars, booleans, nulls and flat lists', () => {
  assert.strictEqual(
    toFrontMatter({ type: 'x', n: 42, ok: true, none: null, tags: ['a', 'b'] }),
    '---\ntype: x\nn: 42\nok: true\nnone: null\ntags: [a, b]\n---'
  );
});

test('toFrontMatter quotes values YAML would otherwise reinterpret', () => {
  // a memo of "no" must not come back as the boolean false
  assert.ok(toFrontMatter({ v: 'no' }).includes('v: "no"'));
  // a colon would start a nested mapping
  assert.ok(toFrontMatter({ v: 'a: b' }).includes('v: "a: b"'));
  // a leading zero must stay a string
  assert.ok(toFrontMatter({ v: '007' }).includes('v: "007"'));
});

test('parseNote round-trips the values toFrontMatter writes', () => {
  const data = { type: 'x', n: 42, ok: true, none: null, s: 'no', tags: ['a', 'b'] };
  const back = parseNote(buildNote(data, 'body')).data;
  assert.deepStrictEqual(back, data);
});

test('parseNote returns the whole text as body when there is no front matter', () => {
  const p = parseNote('just a note');
  assert.deepStrictEqual(p.data, {});
  assert.strictEqual(p.body, 'just a note');
});

test('parseNote does not throw on malformed front matter', () => {
  assert.doesNotThrow(() => parseNote('---\ngarbage without a colon\n---\nbody'));
});

// ── budget ───────────────────────────────────────────────────────────────────

test('budgetToNote writes the expected front matter', () => {
  const note = budgetToNote(
    { id: 'b_1', type: 'expense', catId: 'food', amount: 1200, memo: 'ランチ', date: '2026-07-17' },
    catName('food')
  );
  assert.ok(note.includes('type: karenda-budget'));
  assert.ok(note.includes('entry_id: b_1'));
  assert.ok(note.includes('amount: 1200'));
  assert.ok(note.includes('direction: expense'));
  assert.ok(note.includes('category: 食費'));
  assert.ok(note.includes('tags: [karenda/budget, 家計簿/食費]'));
  assert.ok(note.trimEnd().endsWith('ランチ'), 'the memo is the body');
});

test('budget round trip preserves amount, direction, date and memo', () => {
  const original = { id: 'b_1', type: 'income', catId: 'salary', amount: 250000, memo: '7月分', date: '2026-07-25' };
  const back = budgetFromNote(budgetToNote(original, catName(original.catId)), catId);
  assert.strictEqual(back.id, 'b_1');
  assert.strictEqual(back.type, 'income');
  assert.strictEqual(back.amount, 250000);
  assert.strictEqual(back.date, '2026-07-25');
  assert.strictEqual(back.memo, '7月分');
  assert.strictEqual(back.catId, 'salary');
});

test('budgetFromNote reports an unknown category rather than inventing one', () => {
  const note = budgetToNote({ id: 'b_2', type: 'expense', catId: 'zzz', amount: 1, memo: '', date: '2026-07-17' }, '知らない費');
  const back = budgetFromNote(note, catId);
  assert.strictEqual(back.catId, null);
  assert.strictEqual(back._category, '知らない費');
});

test('budgetFromNote ignores a note of the wrong type', () => {
  assert.strictEqual(budgetFromNote(taskToNote({ id: 't_1', title: 'x' }), catId), null);
});

// ── task ─────────────────────────────────────────────────────────────────────

test('task round trip preserves due date, priority and done', () => {
  const original = { id: 't_1', title: '請求書を出す', dueDate: '2026-07-20', priority: 'high', done: true };
  const back = taskFromNote(taskToNote(original));
  assert.deepStrictEqual(back, original);
});

test('taskToNote writes null for a task with no due date', () => {
  const note = taskToNote({ id: 't_2', title: 'いつか', dueDate: '', priority: 'low', done: false });
  assert.ok(note.includes('due: null'));
  assert.strictEqual(taskFromNote(note).dueDate, '');
});

// ── goal ─────────────────────────────────────────────────────────────────────

test('goal round trip preserves text and done', () => {
  const back = goalFromNote(goalToNote({ id: 'g_1', text: '毎日運動', done: true }, '2026-07-17'));
  assert.strictEqual(back.id, 'g_1');
  assert.strictEqual(back.text, '毎日運動');
  assert.strictEqual(back.done, true);
  assert.strictEqual(back._date, '2026-07-17');
});

// ── file names ───────────────────────────────────────────────────────────────

test('safeFileName strips characters Obsidian forbids in file names', () => {
  assert.strictEqual(safeFileName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i');
  assert.strictEqual(safeFileName('  spaced  out  '), 'spaced out');
});

test('safeFileName tolerates null', () => {
  assert.strictEqual(safeFileName(null), '');
});

// ── project ──────────────────────────────────────────────────────────────────

test('projectToNote writes the fields a vault needs to identify the project', () => {
  const note = projectToNote({ id: 'p_1', name: '山田邸新築', color: '#7c6cf5', archived: false });
  assert.ok(note.includes('type: karenda-project'), note);
  assert.ok(note.includes('project_id: p_1'), note);
  assert.ok(note.includes('name: 山田邸新築'), note);
  assert.ok(note.includes('archived: false'), note);
  assert.ok(note.includes('tags: [karenda/project]'), note);
});

test('projectToNote puts the name in the body, so the note reads as itself', () => {
  const note = projectToNote({ id: 'p_1', name: '山田邸新築', color: '#7c6cf5', archived: false });
  assert.ok(note.trimEnd().endsWith('山田邸新築'),
    'the body should be the project name, got: ' + JSON.stringify(note.slice(-40)));
});

test('projectToNote quotes a colour so YAML does not read # as a comment', () => {
  const note = projectToNote({ id: 'p_1', name: 'X', color: '#7c6cf5', archived: false });
  assert.ok(note.includes('color: "#7c6cf5"'),
    'a bare #7c6cf5 would be swallowed as a YAML comment, got: ' + note);
});

test('projectToNote survives a project with no colour and no archived flag', () => {
  const note = projectToNote({ id: 'p_2', name: 'Rust 勉強' });
  assert.ok(note.includes('project_id: p_2'), note);
  assert.ok(note.includes('archived: false'), 'a missing flag must default to false, got: ' + note);
});
