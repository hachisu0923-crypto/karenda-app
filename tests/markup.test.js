'use strict';
// Static checks on the shipped markup that the browser silently forgives.
// Run: node --test tests/markup.test.js
// (all: node --test tests/*.test.js — a bare tests/ is resolved as a module and fails)
//
// Both checks exist because a real bug got all the way to production:
//   - An unbalanced </div> survived three phases. Browsers auto-correct it, so
//     verifying the rendered layout could never catch it.
//   - A <use href="#lucide-clock"> shipped with no matching <symbol>, leaving
//     eight blank icons in the event editor. The sprite was audited once, when
//     it was created, and not again when a later phase referenced a new name.
// Neither is expensive to check; both are invisible to "does it look right".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'karenda-');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

test('index.html has balanced <div> tags', () => {
  const open = (html.match(/<div\b/g) || []).length;
  const close = (html.match(/<\/div>/g) || []).length;
  assert.strictEqual(close, open,
    `${open} <div> vs ${close} </div> — browsers auto-correct this, so the page will still look right`);
});

test('style.css has balanced braces', () => {
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  assert.strictEqual(close, open, `${open} { vs ${close} }`);
});

test('every #lucide-* reference resolves to a <symbol> in the sprite', () => {
  const referenced = new Set();
  for (const src of [html, js]) {
    for (const m of src.matchAll(/#lucide-([a-z0-9-]+)/g)) referenced.add(m[1]);
  }
  const inSprite = new Set();
  for (const m of html.matchAll(/<symbol id="lucide-([a-z0-9-]+)"/g)) inSprite.add(m[1]);

  const missing = [...referenced].filter(n => !inSprite.has(n));
  assert.deepStrictEqual(missing, [],
    `these render as empty boxes: ${missing.join(', ')}`);
  assert.ok(referenced.size > 0, 'sanity: the scan found some references');
});

test('every var(--token) in style.css is defined somewhere in it', () => {
  const defined = new Set();
  for (const m of css.matchAll(/(?:^\s*|[;{]\s*)(--[a-zA-Z0-9-]+)\s*:/gm)) defined.add(m[1]);

  // A var() with a fallback still works if undefined, so only flag bare ones.
  const bare = new Set();
  for (const m of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) bare.add(m[1]);

  const missing = [...bare].filter(n => !defined.has(n));
  assert.deepStrictEqual(missing, [],
    `undefined and no fallback — the whole declaration is dropped: ${missing.join(', ')}`);
});

test('no element id is defined twice in index.html', () => {
  const seen = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepStrictEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});
