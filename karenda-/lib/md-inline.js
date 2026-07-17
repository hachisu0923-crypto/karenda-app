'use strict';
// Obsidian inline markup ([[wikilink]] and #tag) rendered to safe HTML.
// Loaded in the browser as a classic <script> (attaches to window) and required
// by tests/md-inline.test.js in Node (module.exports). No DOM / Supabase deps.
//
// SECURITY — the order here is the whole point:
//   escape first, THEN wrap the already-escaped text in spans.
// Tokenising first and escaping afterwards would escape the spans we just
// added; escaping first and wrapping after cannot reintroduce markup, because
// after escaping there is no '<' left in the text to close.
(function (root) {

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // [[Note]] or [[Note|alias]] -> Obsidian's own .internal-link class.
  // Runs against ALREADY-ESCAPED text, so the pipe/brackets are still literal
  // but any user '<' has become '&lt;' and can no longer open a tag.
  var WIKILINK = /\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g;

  // #tag — letters (incl. Japanese), digits, _ - /, and NOT preceded by a word
  // char (so "C#" or "abc#def" is not a tag). Mirrors Obsidian's .cm-hashtag.
  var HASHTAG = /(^|[\s(（])#([A-Za-z0-9_\-\/぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]+)/g;

  // Render a raw event title/memo as safe HTML with Obsidian's inline decoration.
  // Links are decoration only: there is no vault to open in a browser, so they
  // are styled, not clickable.
  function renderInline(raw) {
    var out = escHtml(raw);
    out = out.replace(WIKILINK, function (_m, target, alias) {
      var label = (alias != null && alias !== '') ? alias : target;
      return '<span class="internal-link" data-href="' + target + '">' + label + '</span>';
    });
    out = out.replace(HASHTAG, function (_m, lead, tag) {
      return lead + '<span class="cm-hashtag">#' + tag + '</span>';
    });
    return out;
  }

  // Strip the markup and return display text only (for title="" attributes,
  // notifications, and anywhere HTML would be shown literally).
  function stripInline(raw) {
    var out = String(raw == null ? '' : raw);
    out = out.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g, function (_m, target, alias) {
      return (alias != null && alias !== '') ? alias : target;
    });
    return out;
  }

  // Collect the [[targets]] referenced by a string, in order, deduped.
  function extractLinks(raw) {
    var seen = [];
    String(raw == null ? '' : raw).replace(/\[\[([^\[\]|]+)(?:\|[^\[\]]+)?\]\]/g, function (_m, target) {
      var t = target.trim();
      if (t && seen.indexOf(t) === -1) seen.push(t);
      return _m;
    });
    return seen;
  }

  // Collect the #tags in a string, without the leading '#', deduped.
  function extractTags(raw) {
    var seen = [];
    String(raw == null ? '' : raw).replace(HASHTAG, function (_m, _lead, tag) {
      if (seen.indexOf(tag) === -1) seen.push(tag);
      return _m;
    });
    return seen;
  }

  var api = {
    escHtml: escHtml,
    renderInline: renderInline,
    stripInline: stripInline,
    extractLinks: extractLinks,
    extractTags: extractTags,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;              // Node (tests)
  } else {
    root.renderInline = renderInline;  // browser globals
    root.stripInline = stripInline;
    root.extractLinks = extractLinks;
    root.extractTags = extractTags;
  }

})(typeof window !== 'undefined' ? window : globalThis);
