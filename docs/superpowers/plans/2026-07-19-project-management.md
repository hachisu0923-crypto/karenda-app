# プロジェクト（作業テーマ）管理 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** タスクを「作業テーマ（プロジェクト）」で束ねられるようにし、テーマ名をそのまま Obsidian のノート名として使えるようにする。

**Architecture:** Supabase に `projects` テーブルを1枚足し、`tasks` に `project_id` 列を1つ足す。プロジェクト名は Obsidian のノート名と同一とみなし、vault へは書き出しのみ行う（読み戻しは作らない）。既存の「Supabase が正」という設計を踏襲する。

**Tech Stack:** 素の JavaScript（ビルド無し・フレームワーク無し）、Supabase（PostgreSQL + RLS）、`node:test` + `node:assert`、静的配信の PWA。

設計書: `docs/superpowers/specs/2026-07-19-project-management-design.md`

## Global Constraints

- **ライブラリを追加しない。** このアプリはビルド工程を持たず、`karenda-/lib/*.js` は UMD-lite（Node では `module.exports`、ブラウザでは `window` に生やす）で書かれている。新しいファイルも同じ形にする。
- **`karenda-/lib/*.js` は純粋に保つ。** DOM・Supabase・canvas に触れない。テストが Node で直接 require するため。
- **壁時計を読む処理を lib に入れない。** `new Date()` はテストを時計依存にする。日付は呼び出し側から渡す。
- **テストの作法:** `node:test` + `node:assert`、フラットな `test()`（`describe` を使わない）、英語の完全文のテスト名、失敗メッセージに実際の値を埋める、`── section ──` の区切りコメント、モック無し。
- **テスト実行:** `node --test tests/*.test.js`（リポジトリ直下に package.json は無いので `npm test` は存在しない）。着手時点で **204 件が緑**。既存テストを1件も壊さない。
- **リポジトリの改行は CRLF。** 複数行のテキスト置換をする前に改行コードを確認する（過去に LF のパターンで置換が黙って空振りした事故がある）。
- **コミットは Bash のヒアドキュメント（`<<'EOF'`）か `-m` を複数回で行う。** PowerShell の here-string（`@'...'@`）を Bash で使うとメッセージに `@` が混入する（過去に発生済み）。末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` を付ける。
- **未追跡の `README.md` と `2026-07-16_1530_review-project.md` を絶対にコミットしない。** これらは無関係なファイル。`git add` は変更したファイルを明示的に列挙する。
- **プロジェクトの論理 ID は `p_<ms>_<rand>` 形式**（既存の `t_...` / `b_...` と同じ流儀）。
- **削除は実装しない。アーカイブのみ。**

---

### Task 1: プロジェクトの Markdown 書き出しを純粋関数として作る

最初に純粋関数から作る。DB も UI も要らないので単体で完結し、`node --test` だけで検証できる。

**Files:**
- Modify: `karenda-/lib/md-note.js`（`goalFromNote` の後、`safeFileName` の前に追加）
- Test: `tests/md-note.test.js`（末尾に新しい `── project ──` 節を追加）

**Interfaces:**
- Consumes: 既存の `buildNote(data, body)`（同ファイル内。front matter + 本文を組み立てる）
- Produces: `projectToNote(project)` → `string`。`project` は `{ id, name, color, archived }`。後続タスクの vault 書き出しが使う。

- [ ] **Step 1: 失敗するテストを書く**

`tests/md-note.test.js` の末尾（`safeFileName` のテスト群の後）に追加する:

```js
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
```

同ファイル冒頭の require 行に `projectToNote` を足す。現状はこうなっている:

```js
const { toFrontMatter, parseNote, buildNote, budgetToNote, budgetFromNote,
        taskToNote, taskFromNote, goalToNote, goalFromNote, safeFileName } = require('../karenda-/lib/md-note.js');
```

末尾の `safeFileName` の前に `projectToNote,` を追加する。

- [ ] **Step 2: 失敗することを確認する**

Run: `node --test tests/md-note.test.js`
Expected: FAIL。`projectToNote is not a function` で4件落ちる。

- [ ] **Step 3: 最小の実装を書く**

`karenda-/lib/md-note.js` の `goalFromNote` の直後、`// Obsidian forbids ...` コメントの前に追加する:

```js
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
```

同ファイル末尾の `var api = { ... }` に `projectToNote: projectToNote,` を追加する（`goalFromNote` の行の後）。

`color` のクォートは既存の `quoteIfNeeded`（同ファイル 19-28 行）が行うため、追加の処理は要らない。確認済み: 同関数は `/[:#\[\]{}&*!|>'"%@`,]/` に `#` を含んでおり、`#7c6cf5` は `JSON.stringify` されて `"#7c6cf5"` になる。

- [ ] **Step 4: 通ることを確認する**

Run: `node --test tests/md-note.test.js`
Expected: PASS。件数が 13 → 17 に増える。

Run: `node --test tests/*.test.js`
Expected: PASS。204 → 208 件。既存は1件も落ちない。

- [ ] **Step 5: コミット**

```bash
git add karenda-/lib/md-note.js tests/md-note.test.js
git commit -F - <<'EOF'
プロジェクトを Obsidian ノートとして書き出す純粋関数を足す

プロジェクト名はそのまま Obsidian のノート名になるので、本文も名前にする。
vault の中でそのノート自身として読めるようにするため。

読み戻す projectFromNote は作らない。budgetFromNote / taskFromNote /
goalFromNote が実装もテストもされたまま app.js から一度も呼ばれておらず、
既に死んだコードになっている。同じものを増やさない。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 2: DB マイグレーションを書く

**Files:**
- Create: `karenda-/supabase/migrations/20260719000000_projects.sql`

**Interfaces:**
- Produces: テーブル `public.projects`（列 `id, user_id, project_id, name, color, archived, created_at, updated_at`）と `public.tasks.project_id` 列。後続タスクのアプリコードがこれらを読み書きする。

このタスクにテストは無い（SQL の適用は手作業で行うため）。ファイルを書いてコミットするところまでが範囲。

- [ ] **Step 1: マイグレーションを書く**

`karenda-/supabase/migrations/20260719000000_projects.sql` を新規作成する:

```sql
-- プロジェクト（作業テーマ）。タスクを束ねる軸。
--
-- 名前はそのまま Obsidian のノート名として使う。予定タイトルに [[その名前]] と
-- 書けばグラフのノートノードになり、プロジェクトが自然にグラフへ現れる。
--
-- 保存先を Supabase にしたのは、ユーザーがスマホで使うことを優先したため。
-- vault 連携は window.showDirectoryPicker に依存していて（lib/vault-fs.js:26-28）
-- iOS Safari にこの API が無く、vault に置くと iPhone から作れなくなる。

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  name text not null,
  color text not null default '#7c6cf5',
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- upsert(onConflict:'user_id,project_id') に必須。categories に同等の制約が
  -- 無くて初回ログインが 42P10 で壊れた前例がある。
  unique (user_id, project_id)
);

create index if not exists projects_user_id_idx on public.projects (user_id);

alter table public.projects enable row level security;

-- using と with check の両方を書く。既存テーブルは一部 using だけで不揃いだが、
-- 新規は揃えた形にする。
drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- タスクをプロジェクトに紐づける。null = 未分類。既存タスクの移行は要らない。
-- projects への外部キーは張らない。既存のアプリ間テーブルが一貫して FK を
-- 張らない方針（events.cat_id も FK ではない）に合わせる。プロジェクトは
-- 削除せずアーカイブのみなので、参照が宙に浮く事態は起きない。
alter table public.tasks add column if not exists project_id text;
```

- [ ] **Step 2: SQL の構文を目視で確認する**

このリポジトリに SQL を実行する仕組みは無い。既存のマイグレーション（`karenda-/supabase/migrations/20260716000000_recurring_budget_entries.sql`）を開いて並べ、`create table` / `enable row level security` / `create policy` の書式が揃っていることを確認する。

- [ ] **Step 3: コミット**

```bash
git add karenda-/supabase/migrations/20260719000000_projects.sql
git commit -F - <<'EOF'
projects テーブルと tasks.project_id を足すマイグレーション

unique (user_id, project_id) は upsert に必須。categories に同等の制約が
無くて初回ログインが 42P10 で壊れた前例がある。

RLS は using と with check の両方を書く。既存テーブルは一部 using だけで
不揃いだが、新規は揃えた形にする。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

- [ ] **Step 4: 適用方法をユーザーに伝える（実行はしない）**

このマイグレーションは**まだ本番に適用されていない**。オーケストレーターは、Supabase ダッシュボードの SQL エディタで実行する必要があることをユーザーに伝える。**エージェントが本番 DB に適用してはいけない**（破壊的操作であり、ユーザーの明示的な承認が要る）。

---

### Task 3: プロジェクトの読み書き（Supabase）をアプリに足す

**Files:**
- Modify: `karenda-/app.js`（グローバル宣言部 106-138 行付近、`loadFromSupabase()` 578-652 行、タスク CRUD 4356-4418 行の近くに新関数を追加）

**Interfaces:**
- Consumes: `db`（Supabase クライアント、49-63 行）、`currentUser`、`setSyncStatus(status)`（557-574 行）
- Produces:
  - グローバル `projects`（`[{ id, _dbId, name, color, archived, createdAt }]`）
  - `loadProjectsFromSupabase(userId)` → `Promise<Array|null>`（失敗時 null。`loadTasksFromSupabase` と同じ約束）
  - `addProjectToSupabase(project)` → `Promise<void>`
  - `updateProjectInSupabase(project)` → `Promise<void>`
  - `activeProjects()` → `Array`（アーカイブ済みを除いた一覧。後続タスクの UI が使う）
  - `projectById(id)` → `object | null`

このタスクは UI を持たないので、ブラウザで見える変化は無い。検証は「既存 204 件が緑のまま」＋「本番でログインしてもエラーが出ない」。

- [ ] **Step 1: グローバル変数を足す**

`karenda-/app.js` の 109 行（`let events = {};` の行）の直後に追加する:

```js
let projects       = [];   // [{id, _dbId, name, color, archived, createdAt}] 作業テーマ
```

- [ ] **Step 2: 読み書き関数を足す**

`deleteTaskFromSupabase`（4409-4418 行）の直後、`async function initTaskPanel(user) {` の前に追加する:

```js
// ── projects（作業テーマ）──────────────────────────────────────────────────
// タスクを束ねる軸。名前はそのまま Obsidian のノート名として使う。
// 失敗時に null を返すのは loadTasksFromSupabase と同じ約束（空配列と区別する）。

async function loadProjectsFromSupabase(userId) {
  setSyncStatus('syncing');
  try {
    const { data, error } = await db
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    setSyncStatus('synced');
    return (data || []).map(r => ({
      id: r.project_id, _dbId: r.id,
      name: r.name, color: r.color || '#7c6cf5',
      archived: !!r.archived,
      createdAt: new Date(r.created_at).getTime(),
    }));
  } catch (e) {
    // テーブル未作成（42P01）でもアプリ全体は動き続けてほしい。
    console.error('Project load error:', e);
    setSyncStatus('error');
    return null;
  }
}

async function addProjectToSupabase(project) {
  if (!currentUser) return;
  setSyncStatus('syncing');
  try {
    const { data, error } = await db.from('projects').insert({
      user_id: currentUser.id, project_id: project.id,
      name: project.name, color: project.color, archived: !!project.archived,
    }).select().single();
    if (error) throw error;
    project._dbId = data.id;
    setSyncStatus('synced');
  } catch (e) { console.error('Project add error:', e); setSyncStatus('error'); }
}

async function updateProjectInSupabase(project) {
  if (!currentUser || !project._dbId) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('projects').update({
      name: project.name, color: project.color, archived: !!project.archived,
      updated_at: new Date().toISOString(),
    }).eq('id', project._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) { console.error('Project update error:', e); setSyncStatus('error'); }
}

// アーカイブ済みは選択肢に出さない。削除は用意しない（設計どおり）。
function activeProjects() {
  return projects.filter(p => !p.archived);
}

function projectById(id) {
  if (!id) return null;
  return projects.find(p => p.id === id) || null;
}
```

- [ ] **Step 3: 起動時に読み込む**

`initTaskPanel(user)`（4420 行）の中、`const userId = user?.id || 'anon';` の直後、`let tasks;` の前に追加する:

```js
  // プロジェクトはタスクより先に用意する（描画時に名前を引くため）。
  if (userId !== 'anon') {
    projects = await loadProjectsFromSupabase(userId) ?? [];
  } else {
    projects = [];
  }
```

- [ ] **Step 4: ログアウト時にクリアする**

1241 行の `currentUser = null; categories = []; events = {}; overtimeCashouts = []; dailyDrinks = {};` の行を探し、`projects = [];` を足す。**この行は既存の並びが1行に詰まっているので、`categories = [];` の直後に `projects = [];` を挿入する形にする。**

- [ ] **Step 5: 既存テストが緑のままか確認する**

Run: `node --test tests/*.test.js`
Expected: PASS。208 件のまま（app.js は Node のテスト対象外なので件数は変わらない）。

Run: `node --check karenda-/app.js`
Expected: 出力なし（構文エラーが無い）。

- [ ] **Step 6: コミット**

```bash
git add karenda-/app.js
git commit -F - <<'EOF'
プロジェクトの読み書きを足す（UI はまだ無い）

読み込み失敗時に null を返すのは loadTasksFromSupabase と同じ約束にした
（空配列＝プロジェクトが0件、null＝読めなかった、を区別するため）。

削除は用意しない。アーカイブのみ。削除を許すとそのプロジェクトを指す
タスクが宙に浮く。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 4: タスクにプロジェクトを保存できるようにする

**Files:**
- Modify: `karenda-/app.js`（`loadTasksFromSupabase` 4356 行、`addTaskToSupabase` 4380 行、`updateTaskInSupabase` 4394 行）

**Interfaces:**
- Consumes: Task 3 の `projects` / `projectById`
- Produces: `_taskState.tasks` の各要素が `projectId`（文字列 or `''`）を持つようになる。Task 5・6 の UI がこれを読む。

- [ ] **Step 1: 読み込みに projectId を足す**

`loadTasksFromSupabase`（4356 行）の `.map(r => ({ ... }))` の中、`priority: r.priority || 'medium',` の行の直後に追加する:

```js
      projectId: r.project_id || '',
```

- [ ] **Step 2: 追加に projectId を足す**

`addTaskToSupabase`（4380 行）の `.insert({ ... })` の中、`due_date: task.dueDate || '', priority: task.priority || 'medium'` の行を次に置き換える:

```js
      due_date: task.dueDate || '', priority: task.priority || 'medium',
      project_id: task.projectId || null
```

**`|| null` にすること。**空文字列ではなく null を入れる。DB 上の「未分類」は null で表す。

- [ ] **Step 3: 更新に projectId を足す**

`updateTaskInSupabase`（4394 行）の `.update({ ... })` の中、`priority: task.priority || 'medium'` の行を次に置き換える:

```js
      priority: task.priority || 'medium',
      project_id: task.projectId || null
```

- [ ] **Step 4: 構文を確認する**

Run: `node --check karenda-/app.js`
Expected: 出力なし。

Run: `node --test tests/*.test.js`
Expected: PASS、208 件。

- [ ] **Step 5: コミット**

```bash
git add karenda-/app.js
git commit -F - <<'EOF'
タスクにプロジェクトを保存する

DB 上の「未分類」は null で表す（空文字列ではなく）。読み出し時は '' に
落として、UI の select が扱いやすい形にそろえる。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 5: 設定にプロジェクト管理ペインを足す

ここで初めて画面に出る。プロジェクトを作れないと Task 6 のタスク割り当てが試せないので、この順にする。

**Files:**
- Modify: `karenda-/index.html`（縦タブに1枚追加。1055-1065 行付近のタブ列と、`vertical-tab-content` の並び）
- Modify: `karenda-/app.js`（描画とイベントの関数を追加）
- Modify: `karenda-/style.css`（一覧の最小限のスタイル）

**Interfaces:**
- Consumes: Task 3 の `projects` / `addProjectToSupabase` / `updateProjectInSupabase` / `activeProjects`
- Produces: `renderProjectSettings()`（プロジェクト一覧を描き直す）。Task 6 がプロジェクト追加後にこれを呼ぶ必要は無いが、名前を知っておく。

- [ ] **Step 1: 縦タブを足す**

`karenda-/index.html` の `data-settings-tab="vault"` のタブ項目（1061-1063 行）の**直前**に挿入する:

```html
        <div class="vertical-tab-nav-item" data-settings-tab="project" role="tab" tabindex="0">
          <svg class="svg-icon"><use href="#lucide-tag"/></svg><span>プロジェクト</span>
        </div>
```

**`#lucide-tag` を使うこと。`#lucide-folder` はスプライトに存在しない**（計画作成時に確認済み。スプライトにあるのは alarm-clock / calendar-* / clipboard-list / git-fork / list-checks / list-tree / tag / target など43個で、folder は無い）。`tests/markup.test.js` が「全ての `#lucide-*` 参照がシンボルに解決すること」を検査しており、存在しない名前を書くとテストが落ちる（過去に `#lucide-clock` を参照して8個のアイコンが空欄のまま本番に出た事故があり、そのテストはこの再発を防ぐために書かれた）。

- [ ] **Step 2: ペインの中身を足す**

`data-settings-tab="vault"` の `vertical-tab-content` ブロックを探し、その**直前**に挿入する:

```html
      <div class="vertical-tab-content" data-settings-tab="project" style="display:none">
        <div class="setting-item setting-item-heading">
          <div class="setting-item-info">
            <div class="setting-item-name">プロジェクト</div>
            <div class="setting-item-description">タスクを束ねる作業テーマ。名前はそのまま Obsidian のノート名として使えます。</div>
          </div>
        </div>
        <div id="js-project-list"></div>
        <form class="bp-add-form" id="js-project-add-form" autocomplete="off">
          <input class="bp-add-input" id="js-project-input" type="text" placeholder="プロジェクト名を追加…" />
          <input class="form-input" id="js-project-color" type="color" value="#7c6cf5" style="width:48px;padding:2px" />
          <button class="bp-add-btn" type="submit">追加</button>
        </form>
      </div>
```

- [ ] **Step 3: 描画とイベントを足す**

`karenda-/app.js` の Task 3 で足した `projectById` 関数の直後に追加する:

```js
// 設定のプロジェクトペイン。アーカイブ済みは薄く表示し、戻せるようにする。
function renderProjectSettings() {
  const listEl = document.getElementById('js-project-list');
  if (!listEl) return;
  if (!projects.length) {
    listEl.innerHTML = '<div class="setting-item"><div class="setting-item-info">'
      + '<div class="setting-item-description">まだプロジェクトがありません。</div></div></div>';
    return;
  }
  listEl.innerHTML = projects.map(p => `
    <div class="setting-item" data-project-id="${escAttr(p.id)}"${p.archived ? ' style="opacity:.5"' : ''}>
      <div class="setting-item-info">
        <div class="setting-item-name">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${escAttr(p.color)};margin-right:6px"></span>
          ${escHtmlLocal(p.name)}
        </div>
      </div>
      <div class="setting-item-control">
        <button class="btn-secondary" data-project-action="archive">${p.archived ? '戻す' : 'アーカイブ'}</button>
      </div>
    </div>`).join('');
}

// 属性値に入れる文字列のエスケープ。lib/md-inline.js の escHtml は本文向けで
// ここには読み込まれていないので、この2つはローカルに持つ。
function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escHtmlLocal(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function initProjectSettings() {
  const formEl  = document.getElementById('js-project-add-form');
  const inputEl = document.getElementById('js-project-input');
  const colorEl = document.getElementById('js-project-color');
  const listEl  = document.getElementById('js-project-list');
  if (!formEl || !inputEl || !listEl) return;

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (inputEl.value || '').trim();
    if (!name) return;
    const project = {
      id: `p_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      name, color: colorEl?.value || '#7c6cf5',
      archived: false, createdAt: Date.now(),
    };
    projects.push(project);
    inputEl.value = '';
    renderProjectSettings();
    renderTaskPanel();               // 絞り込みの選択肢を更新する
    await addProjectToSupabase(project);
  });

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('[data-project-action]');
    if (!btn) return;
    const row = btn.closest('[data-project-id]');
    const p = projectById(row?.dataset.projectId);
    if (!p) return;
    p.archived = !p.archived;
    renderProjectSettings();
    renderTaskPanel();
    await updateProjectInSupabase(p);
  });
}
```

- [ ] **Step 4: 起動時に初期化する**

Task 3 の Step 3 で足した `projects = await loadProjectsFromSupabase(userId) ?? [];` の直後に追加する:

```js
  renderProjectSettings();
  initProjectSettings();
```

**`initProjectSettings()` は `addEventListener` を張るので、2回呼ぶとイベントが二重登録される。** `initTaskPanel` はログインのたびに呼ばれる可能性があるため、二重登録を防ぐガードを `initProjectSettings` の先頭に入れる:

```js
function initProjectSettings() {
  if (_projectSettingsInited) return;
  _projectSettingsInited = true;
```

あわせて Task 3 の Step 1 で足したグローバル宣言の隣に追加する:

```js
let _projectSettingsInited = false;
```

- [ ] **Step 5: markup テストを含む全テストを確認する**

Run: `node --test tests/*.test.js`
Expected: PASS、208 件。**`tests/markup.test.js` が `<div>` の対応と `#lucide-*` の解決を検査するので、HTML の追加ミスはここで落ちる。** 落ちたらタグの対応を直す。

Run: `node --check karenda-/app.js`
Expected: 出力なし。

- [ ] **Step 6: コミット**

```bash
git add karenda-/index.html karenda-/app.js
git commit -F - <<'EOF'
設定にプロジェクトの管理ペインを足す

追加・色・アーカイブのみ。削除は用意しない（設計どおり。削除を許すと
そのプロジェクトを指すタスクが宙に浮く）。アーカイブ済みは薄く表示して
戻せるようにする。

initProjectSettings は addEventListener を張るので二重登録を防ぐ
フラグを持たせた。initTaskPanel はログインのたびに呼ばれうる。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 6: タスクにプロジェクトを割り当て、絞り込めるようにする

**Files:**
- Modify: `karenda-/index.html`（タスク追加フォーム 469-478 行に select を1つ、フィルタバー 464-468 行に絞り込みを1つ）
- Modify: `karenda-/app.js`（`initTaskPanel` の submit ハンドラ、`renderTaskPanel` の絞り込みと行の描画）

**Interfaces:**
- Consumes: Task 3 の `activeProjects` / `projectById`、Task 4 の `task.projectId`
- Produces: なし（このタスクで機能が完結する）

- [ ] **Step 1: 追加フォームに select を足す**

`karenda-/index.html` のタスク追加フォーム内、`js-task-priority` の `</select>` の**直後**、`<button class="bp-add-btn" type="submit">追加</button>` の**前**に挿入する:

```html
        <select class="budget-select" id="js-task-project" style="width:110px">
          <option value="">未分類</option>
        </select>
```

中身は JS で埋めるので、静的には「未分類」だけ置く。

- [ ] **Step 2: フィルタバーに絞り込みを足す**

`class="task-filter-bar"` の div 内、`data-filter="done"` のボタンの**直後**に挿入する:

```html
        <select class="budget-select" id="js-task-project-filter" style="width:110px;margin-left:auto">
          <option value="all">全プロジェクト</option>
        </select>
```

- [ ] **Step 3: select を埋める関数を足す**

`karenda-/app.js` の `renderProjectSettings` の直後に追加する:

```js
// タスクフォームと絞り込みの選択肢を projects から埋め直す。
// アーカイブ済みは新規割り当ての選択肢に出さないが、絞り込みには出す
// （アーカイブしても、そのタスクを探せなくなっては困る）。
function renderProjectSelects() {
  const formSel = document.getElementById('js-task-project');
  if (formSel) {
    const keep = formSel.value;
    formSel.innerHTML = '<option value="">未分類</option>'
      + activeProjects().map(p =>
          `<option value="${escAttr(p.id)}">${escHtmlLocal(p.name)}</option>`).join('');
    formSel.value = keep;                       // 選択が消えていたら '' に戻る
  }
  const filterSel = document.getElementById('js-task-project-filter');
  if (filterSel) {
    const keep = filterSel.value;
    filterSel.innerHTML = '<option value="all">全プロジェクト</option>'
      + '<option value="none">未分類</option>'
      + projects.map(p =>
          `<option value="${escAttr(p.id)}">${escHtmlLocal(p.name)}${p.archived ? '（済）' : ''}</option>`).join('');
    filterSel.value = keep || 'all';
    if (!filterSel.value) filterSel.value = 'all';
  }
}
```

- [ ] **Step 4: 絞り込みの状態を持たせる**

`initTaskPanel` の `_taskState = { userId, tasks, filter: 'all', els: {...} };` を次に置き換える。`els` に select を2つ足し、`projectFilter` を持たせる:

```js
  _taskState = {
    userId, tasks, filter: 'all', projectFilter: 'all',
    els: { listEl, formEl, inputEl, dateEl, priorityEl, progressEl,
           projectEl: document.getElementById('js-task-project'),
           projectFilterEl: document.getElementById('js-task-project-filter') }
  };
```

- [ ] **Step 5: 追加時に projectId を持たせる**

`initTaskPanel` の submit ハンドラ内、`const priority = priorityEl?.value || 'medium';` の直後に追加する:

```js
    const projectId = _taskState.els.projectEl?.value || '';
```

同じハンドラの `const task = { id, title, dueDate, priority, done: false, createdAt: Date.now() };` を次に置き換える:

```js
    const task = { id, title, dueDate, priority, projectId, done: false, createdAt: Date.now() };
```

- [ ] **Step 6: 絞り込みのイベントを張る**

`initTaskPanel` の末尾、`// Filter buttons` の `document.querySelectorAll('.task-filter').forEach(...)` ブロックの**直後**に追加する:

```js
  // プロジェクト絞り込み
  const pfEl = document.getElementById('js-task-project-filter');
  if (pfEl) {
    pfEl.addEventListener('change', () => {
      if (!_taskState) return;
      _taskState.projectFilter = pfEl.value || 'all';
      renderTaskPanel();
    });
  }
```

- [ ] **Step 7: 絞り込みを描画に効かせる**

`renderTaskPanel()` の `const { tasks, filter, els } = _taskState;` を次に置き換える:

```js
  const { tasks, filter, projectFilter, els } = _taskState;
```

同関数の `const filtered = sorted.filter(t => {` で始まるブロックを探す。既存の絞り込み条件の**後ろ**にプロジェクトの条件を足す。既存が次の形になっているはずなので:

```js
  const filtered = sorted.filter(t => {
    if (filter === 'active') return !t.done;
    if (filter === 'done')   return t.done;
    return true;
  });
```

次に置き換える:

```js
  const filtered = sorted.filter(t => {
    if (filter === 'active' && t.done)  return false;
    if (filter === 'done'   && !t.done) return false;
    if (projectFilter === 'none' && t.projectId) return false;
    if (projectFilter && projectFilter !== 'all' && projectFilter !== 'none'
        && t.projectId !== projectFilter) return false;
    return true;
  });
```

**実際のコードが上と違う形なら、その形に合わせて条件を足すこと。**既存の完了・未完了の意味を変えないことが要件。

同関数の末尾近く、`renderProjectSelects();` を呼ぶ行を追加する（一覧を描くたびに選択肢を最新にする）。`renderTaskPanel` の**先頭**、`if (!_taskState) return;` の直後に置く:

```js
  renderProjectSelects();
```

- [ ] **Step 8: タスク行にプロジェクト名を出す**

`renderTaskPanel` の中で各タスクの行 HTML を組み立てている箇所を探す（`data-task-id` を含むテンプレートリテラル）。優先度や期限のバッジを出している並びに、プロジェクト名のバッジを足す:

```js
      ${t.projectId && projectById(t.projectId)
        ? `<span class="task-project" style="color:${escAttr(projectById(t.projectId).color)}">${escHtmlLocal(projectById(t.projectId).name)}</span>`
        : ''}
```

**既存の行テンプレートの構造に合わせて挿入位置を決めること。**期限バッジ（`task-due`）の隣が読みやすい。

- [ ] **Step 9: スタイルを足す**

`karenda-/style.css` の `.task-due` の定義を探し、その直後に追加する:

```css
.task-project {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--color-base-25);
  white-space: nowrap;
}
```

`--color-base-25` は定義済み（計画作成時に確認済み。ダーク・ライトの両方に定義がある）。`tests/markup.test.js` が「全ての `var(--token)` が定義済みか」を検査しているので、別のトークンに変える場合は先に定義の有無を確認すること。

- [ ] **Step 10: 全テストと構文を確認する**

Run: `node --test tests/*.test.js`
Expected: PASS、208 件。markup テストが HTML と CSS の追加を検査する。

Run: `node --check karenda-/app.js`
Expected: 出力なし。

- [ ] **Step 11: コミット**

```bash
git add karenda-/index.html karenda-/app.js karenda-/style.css
git commit -F - <<'EOF'
タスクをプロジェクトで絞り込めるようにする

タスクには分類の仕組みが一切無く（完了・期限・優先度だけ）、全部が1本の
リストに並んでいた。ここが今回の一番の目的。

アーカイブ済みは新規割り当ての選択肢には出さないが、絞り込みには残す。
アーカイブした途端そのタスクを探せなくなっては困るため。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 7: vault への書き出しにプロジェクトを足す

**Files:**
- Modify: `karenda-/app.js`（`vaultExport` 5923-6003 行。タスク書き出しの後、目標の前）

**Interfaces:**
- Consumes: Task 1 の `mdNote.projectToNote`、Task 3 の `projects`
- Produces: なし

- [ ] **Step 1: 書き出しを足す**

`vaultExport` 内の `// Tasks` ブロックの直後、`// Goals` コメントの前に挿入する:

```js
    // Projects — 名前がそのまま Obsidian のノート名になる。
    if (projects.length) {
      const pd = await vaultFs.dir(base, 'projects', true);
      let pn = 0;
      for (const p of projects) {
        const fname = mdNote.safeFileName(p.name || p.id) + '.md';
        await vaultFs.writeFile(pd, fname, mdNote.projectToNote(p));
        pn++;
      }
      _vaultLog(`プロジェクト ${pn} 件を書き出しました`);
    }
```

**ファイル名に ID を付けない**のがここだけ他と違う点。タスクや家計簿は `${title} ${id}.md` だが、プロジェクトは名前がノート名そのものでなければ `[[山田邸新築]]` と繋がらない。同名のプロジェクトを2つ作ると上書きされるが、それは「同じノートを指している」という意味なので許容する。

- [ ] **Step 2: 構文と全テストを確認する**

Run: `node --check karenda-/app.js`
Expected: 出力なし。

Run: `node --test tests/*.test.js`
Expected: PASS、208 件。

- [ ] **Step 3: コミット**

```bash
git add karenda-/app.js
git commit -F - <<'EOF'
vault の書き出しにプロジェクトを足す

ファイル名に ID を付けないのはここだけ他と違う。プロジェクトは名前が
Obsidian のノート名そのものでなければ [[山田邸新築]] と繋がらないため。
同名を2つ作ると上書きされるが、それは同じノートを指しているという意味。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 8: 本番で動かして確かめ、デプロイする

**Files:** なし（検証とデプロイのみ）

- [ ] **Step 1: マイグレーションの適用をユーザーに依頼する**

`karenda-/supabase/migrations/20260719000000_projects.sql` の中身を提示し、Supabase ダッシュボードの SQL エディタで実行してもらう。**エージェントが本番 DB に対して実行しない。**

適用されたことの確認方法をユーザーに伝える: アプリを開いて設定 → プロジェクトで名前を1つ追加し、エラー通知が出なければ成功。

- [ ] **Step 2: デプロイする**

```bash
git push origin main
```

main への push で Vercel が自動デプロイする。

- [ ] **Step 3: デプロイ完了を確認する**

**順序を守ること。** まず Vercel の deployment API で `state: READY` を確認し、**その後**に本番を curl する（push 直後に curl して古いビルドを見て誤判定した前例がある）。

```bash
curl -s "https://karenda-app-ncra.vercel.app/app.js" | grep -c "loadProjectsFromSupabase"
```
Expected: 1 以上。

- [ ] **Step 4: 実際に触って確かめる**

本番 `https://karenda-app-ncra.vercel.app` で順に確認する:

1. 設定 → プロジェクトで「テスト案件」を追加する → 一覧に色付きで出る
2. タスクを1つ追加し、プロジェクトに「テスト案件」を選ぶ → タスク行にプロジェクト名が出る
3. **ページをリロードする** → プロジェクトもタスクの割り当ても残っている（＝ Supabase に入っている証拠）
4. 絞り込みを「テスト案件」にする → そのタスクだけ出る。「未分類」にする → 出ない
5. **スマホ（別端末）で同じアカウントで開く** → 同じプロジェクトが見える（＝保存先の判断が正しかったことの証拠。**これが今回の設計判断の要**）
6. 設定でアーカイブする → タスク追加フォームの選択肢から消える。絞り込みには「（済）」付きで残る。既存タスクの割り当ては保たれる

**どれか1つでも期待どおりでなければ、その事実を出力ごと報告する。**成功を装わない。

- [ ] **Step 5: 計画の完了を報告する**

実際に確認できたことと、確認できなかったこと（未検証）を分けて報告する。

---

## Self-Review

**1. 仕様の網羅** — 設計書の各節を実装するタスクがあるか:
- 保存先の決定（Supabase が正）→ Task 2・3
- `projects` テーブル → Task 2
- `tasks.project_id` → Task 2・4
- プロジェクト名 = ノート名 → Task 1（本文が名前）・Task 7（ファイル名に ID を付けない）
- 画面: タスク絞り込み → Task 6 / 追加フォーム → Task 6 / 設定ペイン → Task 5
- 削除せずアーカイブのみ → Task 3（`activeProjects`）・Task 5（トグル）
- 読み戻しを作らない → Task 1 で明記
- 検証（リロード後・別端末）→ Task 8 Step 4

網羅漏れなし。

**2. プレースホルダの走査** — 「TBD」「後で実装」「Task N と同様」は無し。コードを変える全ステップに実際のコードを載せた。

**3. 型と名前の一貫性** — `projectId`（アプリ内、camelCase）と `project_id`（DB、snake_case）の対応が Task 3・4・7 で一致。`activeProjects()` / `projectById()` / `renderProjectSelects()` / `renderProjectSettings()` / `initProjectSettings()` の名前が定義箇所と使用箇所で一致。`escAttr` / `escHtmlLocal` は Task 5 で定義し Task 6 で使用（定義が先）。

**4. 既存コードへの依存 — 計画作成時に実物で確認した結果:**
- `#lucide-folder` は**存在しない**。`#lucide-tag` を使うよう Task 5 を修正済み
- `--color-base-25` は**定義済み**（ダーク・ライト両方）。Task 6 はそのまま使える
- `quoteIfNeeded` は `#` を**扱う**。Task 1 の色クォートのテストは通る

**実装者が現物を見て判断する必要が残る箇所**（コードの形が読めなかったため、計画に「実際の形に合わせること」と明記済み）:
- `renderTaskPanel` の絞り込みブロックの実際の形（Task 6 Step 7）
- タスク行のテンプレートリテラルの構造と、バッジの挿入位置（Task 6 Step 8）
- `1241` 行のログアウト処理が1行に詰まっている件（Task 3 Step 4）
