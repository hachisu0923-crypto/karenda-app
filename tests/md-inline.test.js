'use strict';
// Tests for the Obsidian inline markup renderer used by karenda-/app.js.
// Run: node --test tests/md-inline.test.js
// (all: node --test tests/*.test.js — a bare tests/ is resolved as a module and fails)
const test = require('node:test');
const assert = require('node:assert');
const { renderInline, stripInline, extractLinks, extractTags } = require('../karenda-/lib/md-inline.js');

// ── XSS: escaping must happen BEFORE tokenising ──────────────────────────────
// Event titles are user input and go through innerHTML. If we tokenised first
// and escaped after, the spans we add would get escaped; if we escape first,
// no '<' survives to open a tag. These pin that order down.

test('renderInline escapes HTML in a plain title', () => {
  assert.strictEqual(
    renderInline('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;'
  );
});

test('renderInline escapes HTML that sits alongside a wikilink', () => {
  const out = renderInline('<img src=x onerror=alert(1)> [[会議]]');
  assert.ok(!out.includes('<img'), 'raw <img> must not survive');
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the tag must be escaped');
  assert.ok(out.includes('<span class="internal-link" data-href="会議">会議</span>'),
    'the wikilink must still be decorated');
});

test('renderInline escapes quotes so a link target cannot break out of the attribute', () => {
  const out = renderInline('[[a"onmouseover="alert(1)]]');
  assert.ok(!out.includes('onmouseover="alert(1)"'), 'must not produce a live attribute');
  assert.ok(out.includes('&quot;'), 'the quote must be escaped');
});

test('renderInline escapes a script tag inside a hashtag context', () => {
  const out = renderInline('#仕事 <script>alert(1)</script>');
  assert.ok(!out.includes('<script'), 'raw <script> must not survive');
  assert.ok(out.includes('<span class="cm-hashtag">#仕事</span>'));
});

// ── Wikilinks ────────────────────────────────────────────────────────────────

test('renderInline decorates a bare wikilink with Obsidian\'s internal-link class', () => {
  assert.strictEqual(
    renderInline('[[バイト先]]'),
    '<span class="internal-link" data-href="バイト先">バイト先</span>'
  );
});

test('renderInline uses the alias when given [[target|alias]]', () => {
  assert.strictEqual(
    renderInline('[[2026-07-17|今日]]'),
    '<span class="internal-link" data-href="2026-07-17">今日</span>'
  );
});

test('renderInline leaves unmatched brackets alone', () => {
  assert.strictEqual(renderInline('[[未完'), '[[未完');
  assert.strictEqual(renderInline('a ]] b'), 'a ]] b');
});

// ── Hashtags ─────────────────────────────────────────────────────────────────

test('renderInline decorates a hashtag at the start of the string', () => {
  assert.strictEqual(renderInline('#仕事'), '<span class="cm-hashtag">#仕事</span>');
});

test('renderInline decorates a hashtag after whitespace', () => {
  assert.strictEqual(
    renderInline('定例 #仕事'),
    '定例 <span class="cm-hashtag">#仕事</span>'
  );
});

test('renderInline does NOT treat a mid-word # as a tag (C# stays C#)', () => {
  assert.strictEqual(renderInline('C# の勉強'), 'C# の勉強');
});

test('renderInline supports nested tags (Obsidian allows / in tags)', () => {
  assert.strictEqual(
    renderInline('#karenda/daily'),
    '<span class="cm-hashtag">#karenda/daily</span>'
  );
});

// ── stripInline / extractors ─────────────────────────────────────────────────

test('stripInline returns display text with the link syntax removed', () => {
  assert.strictEqual(stripInline('[[2026-07-17|今日]] の予定'), '今日 の予定');
  assert.strictEqual(stripInline('[[バイト先]] で勤務'), 'バイト先 で勤務');
});

test('extractLinks collects targets in order and dedupes', () => {
  assert.deepStrictEqual(extractLinks('[[A]] と [[B|別名]] と [[A]]'), ['A', 'B']);
  assert.deepStrictEqual(extractLinks('リンクなし'), []);
});

test('extractTags collects tags without the hash and dedupes', () => {
  assert.deepStrictEqual(extractTags('#仕事 #個人 #仕事'), ['仕事', '個人']);
  assert.deepStrictEqual(extractTags('タグなし'), []);
});

// ── Non-string input must not throw (titles can be null/undefined) ───────────

test('renderInline tolerates null and undefined', () => {
  assert.strictEqual(renderInline(null), '');
  assert.strictEqual(renderInline(undefined), '');
});
