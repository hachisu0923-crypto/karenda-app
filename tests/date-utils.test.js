'use strict';
// Tests for the shared pure date helpers used by karenda-/app.js.
// Run: node --test tests/date-utils.test.js
// (all: node --test tests/*.test.js — a bare tests/ is resolved as a module and fails)
const test = require('node:test');
const assert = require('node:assert');
const { shiftMonthDate, monthKeyFromDate } = require('../karenda-/lib/date-utils.js');

// ── shiftMonthDate: month navigation must clamp the day so month-end never
//    overflows into the wrong month (the C5 bug). ───────────────────────────
test('shiftMonthDate: +1 from Jan 31 lands in February (no overflow to March)', () => {
  const r = shiftMonthDate(new Date(2026, 0, 31), 1); // month is 0-based: 0=Jan
  assert.strictEqual(r.getFullYear(), 2026);
  assert.strictEqual(r.getMonth(), 1); // 1 = February
});

test('shiftMonthDate: -1 from Mar 31 lands in February (not March)', () => {
  const r = shiftMonthDate(new Date(2026, 2, 31), -1);
  assert.strictEqual(r.getMonth(), 1); // February
});

test('shiftMonthDate: -1 across the year boundary (Jan 2026 -> Dec 2025)', () => {
  const r = shiftMonthDate(new Date(2026, 0, 15), -1);
  assert.strictEqual(r.getFullYear(), 2025);
  assert.strictEqual(r.getMonth(), 11); // December
});

test('shiftMonthDate: +1 across the year boundary (Dec 2026 -> Jan 2027)', () => {
  const r = shiftMonthDate(new Date(2026, 11, 10), 1);
  assert.strictEqual(r.getFullYear(), 2027);
  assert.strictEqual(r.getMonth(), 0); // January
});

test('shiftMonthDate: normal mid-month navigation still works (Jun 29 +1 = Jul)', () => {
  const r = shiftMonthDate(new Date(2026, 5, 29), 1);
  assert.strictEqual(r.getMonth(), 6); // July
});

// ── monthKeyFromDate: budget entries must be filed by their OWN date (C1). ──
test('monthKeyFromDate: derives YYYY-MM from the entry date', () => {
  assert.strictEqual(monthKeyFromDate('2026-07-05'), '2026-07');
  assert.strictEqual(monthKeyFromDate('2026-12-31'), '2026-12');
});

test('monthKeyFromDate: blank/invalid input returns empty string (caller falls back)', () => {
  assert.strictEqual(monthKeyFromDate(''), '');
  assert.strictEqual(monthKeyFromDate(null), '');
  assert.strictEqual(monthKeyFromDate(undefined), '');
});
