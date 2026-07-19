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

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

-- タスクをプロジェクトに紐づける。null = 未分類。既存タスクの移行は要らない。
-- projects への外部キーは張らない。既存のアプリ間テーブルが一貫して FK を
-- 張らない方針（events.cat_id も FK ではない）に合わせる。プロジェクトは
-- 削除せずアーカイブのみなので、参照が宙に浮く事態は起きない。
alter table public.tasks add column if not exists project_id text;
