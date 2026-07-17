'use strict';
// events[dateKey][] <-> an Obsidian daily note ("YYYY-MM-DD.md").
// Loaded in the browser as a classic <script> (attaches to window) and required
// by tests/md-daily.test.js in Node (module.exports). No DOM / Supabase deps.
//
// Shape (see app.js loadFromSupabase):
//   { _dbId, catId, title, time, timeEnd, shiftStart, shiftEnd,
//     breakMinutes, overtimeMinutes, reminderMinutes }
//
// The visible line stays clean Markdown:
//     - [ ] 09:00-10:00 定例ミーティング #仕事
// Anything that has no natural place in that line — the row id, break and
// overtime minutes, the reminder — goes in an Obsidian comment:
//     - [ ] 17:00-22:00 バイト #バイト %%kd id=412 break=60 ot=30%%
// %% %% is real Obsidian syntax and is completely invisible in reading mode.
// (Dataview inline fields like [break:: 60] would show as raw text, because the
// vault this targets has no Dataview installed.)
//
// breakMinutes feeds the wage calculation. Losing it silently changes someone's
// pay, so the round trip has to be lossless, not just pretty.
(function (root) {

  var HHMM = /^(\d{1,2}):(\d{2})$/;

  // "9:00" and "09:00" both parse; anything else is null. app.js's timeStrToMin
  // used to return NaN for "9" (no minutes), which put events at top:NaNpx and
  // made them vanish — reachable the moment a human hand-edits a note.
  function parseTime(s) {
    var m = HHMM.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return { h: h, m: mi };
  }

  function normTime(s) {
    var t = parseTime(s);
    if (!t) return '';
    return String(t.h).padStart(2, '0') + ':' + String(t.m).padStart(2, '0');
  }

  function tagFor(name) {
    // Obsidian tags cannot contain spaces.
    return String(name == null ? '' : name).trim().replace(/\s+/g, '_');
  }

  // ── serialise ──────────────────────────────────────────────────────────────

  function eventToLine(ev, catName) {
    var isShift = !!(ev.shiftStart || ev.shiftEnd);
    var start = normTime(isShift ? ev.shiftStart : ev.time);
    var end   = normTime(isShift ? ev.shiftEnd   : ev.timeEnd);

    var parts = [];
    if (start && end) parts.push(start + '-' + end);
    else if (start)   parts.push(start);

    var label = String(ev.title == null ? '' : ev.title).trim();
    if (!label && catName) label = catName;
    if (label) parts.push(label);

    var tag = tagFor(catName);
    if (tag) parts.push('#' + tag);

    // Only emit the comment when there is something that would otherwise be lost.
    var meta = [];
    if (ev._dbId != null && ev._dbId !== '') meta.push('id=' + ev._dbId);
    if (+ev.breakMinutes > 0)                meta.push('break=' + (+ev.breakMinutes));
    if (+ev.overtimeMinutes > 0)             meta.push('ot=' + (+ev.overtimeMinutes));
    if (ev.reminderMinutes != null && ev.reminderMinutes !== '') meta.push('rem=' + (+ev.reminderMinutes));
    if (isShift)                             meta.push('shift=1');
    if (meta.length) parts.push('%%kd ' + meta.join(' ') + '%%');

    return '- [ ] ' + parts.join(' ');
  }

  // events for one day -> the full note text.
  // `catName(catId) -> string` lets the caller resolve category names without
  // this module knowing about the category store.
  function toDailyNote(dateKey, dayEvents, catName) {
    var resolve = typeof catName === 'function' ? catName : function () { return ''; };
    var lines = [];
    lines.push('---');
    lines.push('date: ' + dateKey);
    lines.push('tags: [karenda/daily]');
    lines.push('---');
    lines.push('');
    lines.push('## 予定');
    lines.push('');
    (dayEvents || []).forEach(function (ev) {
      lines.push(eventToLine(ev, resolve(ev.catId)));
    });
    lines.push('');
    return lines.join('\n');
  }

  // ── parse ──────────────────────────────────────────────────────────────────

  function parseMeta(s) {
    var out = {};
    var m = /%%kd\s+([^%]*)%%/.exec(s);
    if (!m) return out;
    m[1].trim().split(/\s+/).forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    });
    return out;
  }

  // One "- [ ] ..." line -> an event, or null if the line isn't a task.
  // `catId(tagName) -> id|null` resolves a #tag back to a category; returning
  // null means "unknown", and the caller decides what to do (app.js warns and
  // falls back rather than inventing a category).
  function lineToEvent(line, catId) {
    var resolve = typeof catId === 'function' ? catId : function () { return null; };
    var m = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (!m) return null;

    var rest = m[2];
    var meta = parseMeta(rest);
    rest = rest.replace(/%%kd\s+[^%]*%%/, '').trim();

    // trailing/embedded tag
    var tag = null;
    rest = rest.replace(/(^|\s)#([^\s#]+)/, function (_all, lead, t) { tag = t; return lead; }).trim();

    // leading time range
    var time = '', timeEnd = '';
    var t = /^(\d{1,2}:\d{2})(?:\s*[-–~]\s*(\d{1,2}:\d{2}))?\s+/.exec(rest);
    if (t) {
      time = normTime(t[1]);
      timeEnd = t[2] ? normTime(t[2]) : '';
      // A malformed time ("9:xx") normalises to '' — treat the line as all-day
      // rather than emitting a value that renders at NaN px.
      if (time) rest = rest.slice(t[0].length).trim();
    }

    var isShift = meta.shift === '1';
    var ev = {
      _dbId:           meta.id != null ? meta.id : undefined,
      catId:           resolve(tag),
      title:           rest,
      time:            isShift ? '' : time,
      timeEnd:         isShift ? '' : timeEnd,
      shiftStart:      isShift ? time : '',
      shiftEnd:        isShift ? timeEnd : '',
      breakMinutes:    meta.break != null ? +meta.break : 0,
      overtimeMinutes: meta.ot != null ? +meta.ot : 0,
      reminderMinutes: meta.rem != null ? +meta.rem : null,
      _tag:            tag,       // so the caller can report unknown categories
      _done:           m[1].toLowerCase() === 'x',
    };
    return ev;
  }

  // Note text -> events for that day. Only the "## 予定" section is read; other
  // sections of the user's daily note are left alone.
  function fromDailyNote(text, catId) {
    var out = [];
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var inSection = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^##\s+予定\s*$/.test(line)) { inSection = true; continue; }
      if (inSection && /^#{1,6}\s+/.test(line)) break;   // next heading ends it
      if (!inSection) continue;
      var ev = lineToEvent(line, catId);
      if (ev) out.push(ev);
    }
    return out;
  }

  // Read the YAML front matter's `date:` without a YAML parser.
  function dateKeyFromNote(text) {
    var m = /^---\r?\n(?:[\s\S]*?\r?\n)?date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/m.exec(String(text || ''));
    return m ? m[1] : '';
  }

  var api = {
    parseTime: parseTime,
    normTime: normTime,
    eventToLine: eventToLine,
    lineToEvent: lineToEvent,
    toDailyNote: toDailyNote,
    fromDailyNote: fromDailyNote,
    dateKeyFromNote: dateKeyFromNote,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;                  // Node (tests)
  } else {
    root.mdDaily = api;                    // browser global (namespaced)
  }

})(typeof window !== 'undefined' ? window : globalThis);
