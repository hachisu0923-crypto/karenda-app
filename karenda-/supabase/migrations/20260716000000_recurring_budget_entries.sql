-- サブスク・月額支払いなど、毎月繰り返す家計簿項目。
create table if not exists recurring_budget_entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  recurring_id text not null,
  type         text not null check (type in ('expense', 'income')),
  cat_id       text not null,
  amount       integer not null check (amount > 0),
  memo         text not null default '',
  day_of_month integer not null check (day_of_month between 1 and 31),
  start_date   text not null,
  end_date     text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (user_id, recurring_id)
);

alter table recurring_budget_entries enable row level security;
drop policy if exists "own recurring budget entries" on recurring_budget_entries;
create policy "own recurring budget entries" on recurring_budget_entries
  for all using (auth.uid() = user_id);
