-- Security hardening (advisor: function_search_path_mutable).
-- Pin a non-mutable search_path on the updated_at trigger functions. Both only
-- call now() (pg_catalog, always in scope), so an empty search_path is safe.
-- Applied to production on 2026-06-29; recorded here for repo/prod parity.
-- Defensive (IF the function exists) so a fresh `db reset` doesn't fail when a
-- given function isn't present.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as f
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('set_updated_at','update_updated_at')
  loop
    execute format('alter function %s set search_path = %L', r.f, '');
  end loop;
end $$;
