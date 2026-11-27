begin;
-- Keep SECURITY DEFINER implementations outside the Data API exposed schema.
create schema desk_private;
revoke all on schema desk_private from public, anon;
grant usage on schema desk_private to authenticated;
alter function public.desk_snapshot() set schema desk_private;
alter function public.desk_commit(uuid,jsonb) set schema desk_private;

create function public.desk_snapshot() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select desk_private.desk_snapshot();
$$;
create function public.desk_commit(operation_id uuid, changes jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select desk_private.desk_commit(operation_id,changes);
$$;
revoke all on function public.desk_snapshot() from public,anon;
revoke all on function public.desk_commit(uuid,jsonb) from public,anon;
grant execute on function public.desk_snapshot() to authenticated;
grant execute on function public.desk_commit(uuid,jsonb) to authenticated;
-- Explicit deny documents that receipts are exclusively for the trusted transaction.
create policy no_client_receipts on public.desk_operations for all to authenticated
  using (false) with check (false);
-- Supabase's auto-RLS event trigger runs as its owner, never as an API client.
do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
commit;
