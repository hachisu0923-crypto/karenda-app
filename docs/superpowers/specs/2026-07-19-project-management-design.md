# プロジェクト（作業テーマ）管理 — 設計

作成日: 2026-07-19

## Context

karenda-app には、やることを束ねる軸が予定にしか無い。予定はカテゴリ（仕事・個人・バイト等）で分類できるが、**タスクには分類の仕組みが一切無く**、完了・期限・優先度しか持たない（`karenda-/app.js:4366-4371`）。そのため「この作業テーマに関するタスクだけ見る」ができず、全部が1本のリストに並ぶ。

ユーザーは仕事の案件も個人の取り組みも同じ仕組みで束ねたい。あわせて、データの保存先をどうすべきかの判断を求めている。

### ユーザーが決めたこと（2026-07-19 確認）

- **プロジェクト = 仕事以外も含む作業テーマ**（設計案件だけに限定しない）
- **紐づけるのはタスクとノート**（予定・家計簿は今回の対象外）
- **スマホで使えることを優先**する

## 保存先の決定: Supabase を正とし、Obsidian へは書き出すだけ

現状の設計（`karenda-/app.js:5883` に「Supabase stays the source of truth」と明記）を踏襲する。理由は3つ、いずれも実際のコードで確認した事実に基づく。

1. **スマホ優先と決まったため。** vault 連携は `window.showDirectoryPicker` の有無で可否を判定しており（`karenda-/lib/vault-fs.js:26-28`）、iOS Safari にこの API が無い。プロジェクトを vault に置くと iPhone から作成も閲覧もできなくなる。
2. **正を2つにすると黙ってデータが消えるため。** このアプリには競合検出の仕組みが無い。タイムスタンプ比較もマージも存在せず、vault インポートは対象月の予定を全削除してから入れ直す（`karenda-/app.js:6042-6045`）。双方向に書ける状態にすると、どちらかの編集が失われる。
3. **既存の守りにそのまま乗るため。** 全テーブルが `user_id` + RLS でユーザー分離済み。テーブルを1枚足すだけで同じ保護が効く。

### 却下した案

- **vault の Markdown を正にする** — スマホから編集できなくなる。ユーザーの優先順位に反する。
- **双方向同期** — 競合解決の機構をゼロから作ることになり、今回の目的（タスクを束ねる）に対して重い。

## データ設計

### 新テーブル `projects`

既存テーブルの流儀に合わせる。DB 主キーは uuid、アプリ側の論理 ID はクライアント生成の text（`tasks.task_id` = `t_...`、`budget_entries.entry_id` = `b_...` と同じ）。

```sql
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,               -- クライアント生成 'p_<ms>_<rand>'
  name text not null,                     -- 作業テーマ名。Obsidian のノート名と一致させる
  color text not null default '#7c6cf5',
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id)
);
create index if not exists projects_user_id_idx on public.projects (user_id);
alter table public.projects enable row level security;
create policy "own projects" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

`unique (user_id, project_id)` は必須。カテゴリで同等の制約が無く初回ログインが 42P10 で壊れた前例がある（`karenda-/supabase/migrations/20260219000000_base_events_tasks_categories.sql:74-76` のコメント）。

RLS は `using` と `with check` の**両方**を書く。既存テーブルの一部は `using` のみで不揃いだが、新規は揃えた形にする。

### `tasks` への列追加

```sql
alter table public.tasks add column if not exists project_id text;
```

null 可。**既存タスクの移行は不要**（全て null = 未分類として扱う）。

`projects.project_id` への外部キーは張らない。既存のアプリ間テーブルが一貫して FK を張らない方針（`events.cat_id` も FK ではない）に合わせる。プロジェクトは削除せずアーカイブのみとするため（後述「画面」節）、参照が宙に浮く事態は起きない。

### アプリ内の形

```js
// projects: [{ id, _dbId, name, color, archived, createdAt }]
// tasks:    [{ id, _dbId, title, done, dueDate, priority, createdAt, projectId }]
```

`projects` はグローバルに保持し、`loadFromSupabase()`（`karenda-/app.js:578-652`）で他のデータと一緒に読む。タスクは既に `_taskState.tasks` にあるので `projectId` を足すだけ。

## ノートとの紐づけ: プロジェクト名 = ノート名

新しい仕組みを作らず、**既にあるものを繋ぐ**。

予定タイトルの `[[リンク]]` は既に `extractLinks()` で抽出され、グラフのノートノードになっている（`karenda-/lib/graph-model.js`）。プロジェクト名をそのままノート名として使えば、`[[山田邸新築]]` と書いた予定が案件ノートに繋がり、グラフに現れる。

vault への書き出しは既存の `vaultExport`（`karenda-/app.js:5923-6003`）に `karenda/projects/` を足す:

```markdown
---
type: karenda-project
project_id: p_1
name: 山田邸新築
color: "#7c6cf5"
archived: false
tags: [karenda/project]
---

山田邸新築
```

**読み戻し（`projectFromNote`）は作らない。** `budgetFromNote` / `taskFromNote` / `goalFromNote` は実装もテストもされているが `app.js` から一度も呼ばれておらず、既に死んだコードになっている。同じものを増やさない。

## 画面

1. **タスクパネルにプロジェクトの絞り込み** — 既存の `_taskState.filter`（`karenda-/app.js:4525`）の隣に置く。「すべて / 未分類 / 各プロジェクト」。
2. **タスク追加・編集フォームにプロジェクト選択** — アーカイブ済みは選択肢に出さない。
3. **設定にプロジェクト管理ペイン** — 追加・改名・色変更・アーカイブ。既存の設定モーダルの縦タブ（`karenda-/index.html:1062` 付近）に1枚追加する。

削除は当面設けず**アーカイブのみ**とする。削除を許すと、そのプロジェクトを指すタスクが宙に浮く後始末が要る。アーカイブなら一覧から消えるだけで参照は保たれる。

## スコープ外（今回やらないこと）

- 予定・家計簿とプロジェクトの紐づけ（ユーザーはタスクとノートを選択）
- vault からのプロジェクト読み戻し
- グラフビューでのプロジェクトの特別扱い（色分け・専用ノード種）。プロジェクト名を `[[リンク]]` に書けば既存の仕組みでノートとして出る
- プロジェクトの進捗率・期限・担当者

## 別途報告済みのリスク（本設計の対象外）

**目標（goal）が localStorage にしか無い**（`karenda-/app.js:4064`、キー `daily_goal_v1`）。Supabase テーブルが無く、ブラウザのデータを消すと失われる。端末外に出る唯一の手段が Markdown 書き出しという状態。今回は触らないが、直す価値がある。

## 検証

- `node --test tests/*.test.js` が全件緑（現在 204 件）
- 追加するテスト:
  - `projectToNote` の出力が期待どおり（既存 `md-note.test.js` の作法に合わせる）
  - タスクとプロジェクトの相互変換で `projectId` が往復して失われない
  - アーカイブ済みプロジェクトが選択肢に出ない
- 実データでの確認:
  - プロジェクトを作る → タスクに割り当てる → 絞り込みで出る
  - **リロード後も保持されている**（Supabase に入っている証拠）
  - **スマホ（別端末）で開いても同じものが見える**（保存先の判断が正しかったことの証拠。これが今回の設計判断の要）
  - アーカイブすると選択肢から消え、既存タスクの割り当ては保たれる
- Vercel へデプロイし、本番 URL で上記を確認（ユーザーの恒久指示）
