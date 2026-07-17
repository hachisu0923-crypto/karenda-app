-- 既存の月額・サブスク支払いを、通常支出とは別の専用カテゴリへ移行する。
update recurring_budget_entries
set cat_id = 'subscription'
where cat_id is distinct from 'subscription';
