'use strict';
// Individual Obsidian notes with YAML front matter, for the records that carry
// more than a daily-note line can: budget entries, tasks, goals.
// Loaded in the browser as a classic <script> (attaches to window) and required
// by tests/md-note.test.js in Node (module.exports). No DOM / Supabase deps.
//
// Shapes (see app.js):
//   budget { id, type: 'expense'|'income', catId, amount, memo, date, source?, createdAt }
//   task   { id, title, dueDate, priority: 'high'|'medium'|'low', done, createdAt }
//   goal   { id, text, done }   — localStorage `daily_goal_v1` only; NOT synced
//                                 to Supabase, unlike the other two.
//
// This is a deliberately small front-matter writer/reader, not a YAML engine:
// it only handles the scalar and flat-list forms these notes actually use.
(function (root) {

  // ── YAML front matter (scalars + flat lists only) ──────────────────────────

  function quoteIfNeeded(v) {
    var s = String(v);
    // Quote anything YAML would otherwise reinterpret.
    if (s === '') return '""';
    if (/^[\s]|[\s]$/.test(s)) return JSON.stringify(s);
    if (/[:#\[\]{}&*!|>'"%@`,]/.test(s)) return JSON.stringify(s);
    if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return JSON.stringify(s);
    if (/^-?\d+(\.\d+)?$/.test(s)) return JSON.stringify(s);   // keep "007" a string
    return s;
  }

  function formatValue(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) return '[' + v.map(quoteIfNeeded).join(', ') + ']';
    return quoteIfNeeded(v);
  }

  function toFrontMatter(obj) {
    var lines = ['---'];
    Object.keys(obj).forEach(function (k) {
      if (obj[k] === undefined) return;
      lines.push(k + ': ' + formatValue(obj[k]));
    });
    lines.push('---');
    return lines.join('\n');
  }

  function parseScalar(s) {
    var t = s.trim();
    if (t === '') return '';
    if (t === 'null' || t === '~') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^\[.*\]$/.test(t)) {
      var inner = t.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map(function (x) { return parseScalar(x); });
    }
    if ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'")) {
      try { return JSON.parse(t.replace(/^'|'$/g, '"')); } catch (_) { return t.slice(1, -1); }
    }
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
    return t;
  }

  // Note text -> { data, body }. No front matter -> data {} and the whole text
  // as body, so a hand-written note never throws.
  function parseNote(text) {
    var s = String(text == null ? '' : text);
    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(s);
    if (!m) return { data: {}, body: s };
    var data = {};
    m[1].split(/\r?\n/).forEach(function (line) {
      if (!line.trim() || /^\s*#/.test(line)) return;
      var i = line.indexOf(':');
      if (i < 0) return;
      data[line.slice(0, i).trim()] = parseScalar(line.slice(i + 1));
    });
    return { data: data, body: m[2] };
  }

  function buildNote(data, body) {
    return toFrontMatter(data) + '\n\n' + String(body == null ? '' : body).replace(/^\n+/, '');
  }

  // ── budget ────────────────────────────────────────────────────────────────

  function budgetToNote(entry, catName) {
    return buildNote({
      type: 'karenda-budget',
      entry_id: entry.id,
      date: entry.date || '',
      amount: +entry.amount || 0,
      direction: entry.type === 'income' ? 'income' : 'expense',
      category: catName || '',
      source: entry.source || null,
      tags: ['karenda/budget'].concat(catName ? ['家計簿/' + String(catName).replace(/\s+/g, '_')] : []),
    }, entry.memo || '');
  }

  function budgetFromNote(text, catId) {
    var p = parseNote(text);
    if (p.data.type !== 'karenda-budget') return null;
    var resolve = typeof catId === 'function' ? catId : function () { return null; };
    return {
      id: p.data.entry_id,
      type: p.data.direction === 'income' ? 'income' : 'expense',
      catId: resolve(p.data.category),
      amount: +p.data.amount || 0,
      memo: p.body.trim(),
      date: p.data.date || '',
      source: p.data.source || null,
      _category: p.data.category,
    };
  }

  // ── task ──────────────────────────────────────────────────────────────────

  function taskToNote(task) {
    return buildNote({
      type: 'karenda-task',
      task_id: task.id,
      due: task.dueDate || null,
      priority: task.priority || 'medium',
      done: !!task.done,
      tags: ['karenda/task'],
    }, task.title || '');
  }

  function taskFromNote(text) {
    var p = parseNote(text);
    if (p.data.type !== 'karenda-task') return null;
    return {
      id: p.data.task_id,
      title: p.body.trim(),
      dueDate: p.data.due || '',
      priority: p.data.priority || 'medium',
      done: !!p.data.done,
    };
  }

  // ── goal ──────────────────────────────────────────────────────────────────
  // Goals live only in localStorage (daily_goal_v1) — exporting them to .md is
  // the only way they leave the device at all.

  function goalToNote(goal, dateKey) {
    return buildNote({
      type: 'karenda-goal',
      goal_id: goal.id,
      date: dateKey || '',
      done: !!goal.done,
      tags: ['karenda/goal'],
    }, goal.text || '');
  }

  function goalFromNote(text) {
    var p = parseNote(text);
    if (p.data.type !== 'karenda-goal') return null;
    return {
      id: p.data.goal_id,
      text: p.body.trim(),
      done: !!p.data.done,
      _date: p.data.date || '',
    };
  }

  // ── project ───────────────────────────────────────────────────────────────
  // A project's name is also its Obsidian note name, so the body is the name:
  // the note reads as itself in the vault, not as a record about something else.

  function projectToNote(project) {
    return buildNote({
      type: 'karenda-project',
      project_id: project.id,
      name: project.name || '',
      color: project.color || '',
      archived: !!project.archived,
      tags: ['karenda/project'],
    }, project.name || '');
  }

  // Obsidian forbids \ / : * ? " < > | in file names.
  function safeFileName(s) {
    return String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  var api = {
    toFrontMatter: toFrontMatter,
    parseNote: parseNote,
    buildNote: buildNote,
    budgetToNote: budgetToNote,
    budgetFromNote: budgetFromNote,
    taskToNote: taskToNote,
    taskFromNote: taskFromNote,
    goalToNote: goalToNote,
    goalFromNote: goalFromNote,
    projectToNote: projectToNote,
    safeFileName: safeFileName,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;      // Node (tests)
  } else {
    root.mdNote = api;         // browser global (namespaced)
  }

})(typeof window !== 'undefined' ? window : globalThis);
