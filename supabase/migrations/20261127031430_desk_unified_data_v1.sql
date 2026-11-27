begin;
-- One row per existing business aggregate; no replacement of a complete Desk JSON document.
create table public.desk_entities (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('settings','subjects','exams','plans','sessions','timer','reviews',
    'academic','terms','assessments','results','materials','versions','adjustments')),
  id text not null check (length(id) between 1 and 200),
  payload jsonb,
  ordinal integer not null default 0 check (ordinal >= 0),
  version bigint not null default 1 check (version > 0),
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id,kind,id),
  check ((deleted and payload is null) or (not deleted and payload is not null)),
  check (kind not in ('settings','timer','academic','versions') or id = 'current')
);
create index desk_entities_updated on public.desk_entities(user_id,updated_at);
create table public.desk_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  changes jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,id)
);
alter table public.desk_entities enable row level security;
alter table public.desk_operations enable row level security;
create policy owner_read on public.desk_entities for select to authenticated using ((select auth.uid()) = user_id);
-- No direct write grant or write policy. All mutations go through the transaction below.
revoke all on public.desk_entities, public.desk_operations from public, anon, authenticated;
grant select on public.desk_entities to authenticated;

create function public.desk_snapshot() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id,'payload',payload,
    'ordinal',ordinal,'version',version,'deleted',deleted,'createdAt',created_at,'updatedAt',updated_at) order by kind,id),'[]'::jsonb)
  from public.desk_entities where user_id = auth.uid();
$$;
revoke all on function public.desk_snapshot() from public, anon;
grant execute on function public.desk_snapshot() to authenticated;

create function public.desk_commit(operation_id uuid, changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  item jsonb;
  previous public.desk_entities%rowtype;
  receipt jsonb;
  doc jsonb;
begin
  if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if operation_id is null or jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes) = 0
    or jsonb_array_length(changes) > 100000 then
    raise exception 'Invalid operation' using errcode='22023';
  end if;
  -- Serialize each account, including creation of the very first row and receipt.
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  select o.changes into receipt from public.desk_operations o where o.user_id=uid and o.id=operation_id;
  if found then
    if receipt <> changes then raise exception 'Operation ID reused with different changes' using errcode='22023'; end if;
    return public.desk_snapshot();
  end if;
  if exists(select 1 from jsonb_array_elements(changes) c group by c->>'kind',c->>'id' having count(*) > 1) then
    raise exception 'Duplicate operation target' using errcode='22023';
  end if;
  for item in select value from jsonb_array_elements(changes) loop
    if not (item ?& array['kind','id','expected','deleted','payload']) or
      jsonb_typeof(item->'kind') <> 'string' or jsonb_typeof(item->'id') <> 'string' or
      jsonb_typeof(item->'deleted') <> 'boolean' then
      raise exception 'Invalid change' using errcode='22023';
    end if;
    select * into previous from public.desk_entities e
      where e.user_id=uid and e.kind=item->>'kind' and e.id=item->>'id';
    if found then
      if previous.deleted or item->>'expected' is null or previous.version <> (item->>'expected')::bigint then
        raise exception 'Record changed or deleted: %/%',item->>'kind',item->>'id' using errcode='40001';
      end if;
      update public.desk_entities set payload=case when (item->>'deleted')::boolean then null else item->'payload' end,
        deleted=(item->>'deleted')::boolean, ordinal=coalesce((item->>'ordinal')::integer,ordinal), version=version+1, updated_at=now()
        where user_id=uid and kind=item->>'kind' and id=item->>'id';
    else
      if item->>'expected' is not null then
        raise exception 'Record missing: %/%',item->>'kind',item->>'id' using errcode='40001';
      end if;
      insert into public.desk_entities(user_id,kind,id,payload,ordinal,deleted)
        values(uid,item->>'kind',item->>'id',case when (item->>'deleted')::boolean then null else item->'payload' end,
          coalesce((item->>'ordinal')::integer,0),(item->>'deleted')::boolean);
    end if;
  end loop;
  -- Validate live references after the entire transaction (including atomic timer -> session conversion).
  if exists(select 1 from public.desk_entities e where e.user_id=uid and not e.deleted
    and e.kind in ('sessions','exams','assessments','results','materials','timer')
    and e.payload <> 'null'::jsonb and (not (e.payload ? 'subjectId') or not exists(
      select 1 from public.desk_entities s where s.user_id=uid and s.kind='subjects'
        and s.id=e.payload->>'subjectId' and not s.deleted))) then
    raise exception 'Missing course reference' using errcode='23503';
  end if;
  if exists(select 1 from public.desk_entities e where e.user_id=uid and not e.deleted
    and e.kind in ('assessments','results','materials') and not exists(
      select 1 from public.desk_entities t where t.user_id=uid and t.kind='terms'
        and t.id=e.payload->>'termId' and not t.deleted)) then
    raise exception 'Missing term reference' using errcode='23503';
  end if;
  for item in select e.payload from public.desk_entities e where e.user_id=uid and e.kind='terms' and not e.deleted loop
    if exists(select 1 from jsonb_array_elements(item->'courses') c where not exists(
      select 1 from public.desk_entities s where s.user_id=uid and s.kind='subjects'
        and not s.deleted and s.id=c->>'subjectId')) then
      raise exception 'Missing term course reference' using errcode='23503';
    end if;
  end loop;
  select payload into doc from public.desk_entities where user_id=uid and kind='timer' and id='current' and not deleted;
  if doc <> 'null'::jsonb and exists(select 1 from public.desk_entities where user_id=uid and kind='sessions'
    and id=doc->>'id' and not deleted) then
    raise exception 'Timer already saved' using errcode='23514';
  end if;
  if exists(select 1 from public.desk_entities e where e.user_id=uid and not e.deleted and e.kind='sessions'
    and (e.payload->>'id' is distinct from e.id or (e.payload->>'minutes')::numeric not between 1 and 1440)) then
    raise exception 'Invalid session' using errcode='23514';
  end if;
  if (select count(*) from public.desk_entities where user_id=uid and not deleted
    and kind in ('settings','timer','academic','versions')) <> 4 then
    raise exception 'Incomplete Desk data' using errcode='23514';
  end if;
  insert into public.desk_operations(user_id,id,changes) values(uid,operation_id,changes);
  return public.desk_snapshot();
end;
$$;
revoke all on function public.desk_commit(uuid,jsonb) from public,anon;
grant execute on function public.desk_commit(uuid,jsonb) to authenticated;
commit;
