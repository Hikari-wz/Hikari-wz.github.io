begin;

alter table public.desk_entities
  drop constraint if exists desk_entities_kind_check;
alter table public.desk_entities
  add constraint desk_entities_kind_check check (kind in (
    'settings','subjects','exams','plans','sessions','timer','reviews',
    'academic','terms','assessments','results','materials','versions','adjustments',
    'prepTasks','prepMaterials'
  ));

create or replace function desk_private.valid_prep_payload(
  entity_kind text,
  entity_id text,
  payload jsonb
) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  week_day date;
  position_value numeric;
  bytes_value numeric;
begin
  if payload is null or jsonb_typeof(payload) <> 'object'
    or payload->>'id' is distinct from entity_id
    or jsonb_typeof(payload->'termId') is distinct from 'string'
    or length(payload->>'termId') not between 1 and 100
    or payload->>'termId' !~ '^[A-Za-z0-9_-]+$'
    or jsonb_typeof(payload->'courseId') is distinct from 'string'
    or length(payload->>'courseId') not between 1 and 100
    or payload->>'courseId' !~ '^[A-Za-z0-9_-]+$' then
    return false;
  end if;

  if entity_kind = 'prepTasks' then
    if entity_id !~ '^[A-Za-z0-9_-]{1,100}$'
      or jsonb_typeof(payload->'week') is distinct from 'string'
      or payload->>'week' !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
      or jsonb_typeof(payload->'title') is distinct from 'string'
      or length(btrim(payload->>'title')) not between 1 and 200
      or jsonb_typeof(payload->'notes') is distinct from 'string'
      or length(payload->>'notes') > 10000
      or jsonb_typeof(payload->'done') is distinct from 'boolean'
      or jsonb_typeof(payload->'position') is distinct from 'number'
      or payload->>'position' !~ '^[0-9]+$' then
      return false;
    end if;
    if substring(payload->>'week',1,4)::int not between 1900 and 9998 then
      return false;
    end if;
    position_value := (payload->>'position')::numeric;
    if position_value > 9007199254740991 or position_value <> trunc(position_value) then
      return false;
    end if;
    begin
      week_day := (payload->>'week')::date;
    exception when others then
      return false;
    end;
    if extract(isodow from week_day) <> 1 then
      return false;
    end if;
    if payload ? 'sourceKey'
      and (jsonb_typeof(payload->'sourceKey') is distinct from 'string'
        or length(payload->>'sourceKey') not between 1 and 500) then
      return false;
    end if;
    return true;
  end if;

  if entity_kind = 'prepMaterials' then
    if entity_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(payload->'name') is distinct from 'string'
      or length(btrim(payload->>'name')) not between 1 and 200
      or jsonb_typeof(payload->'kind') is distinct from 'string'
      or payload->>'kind' not in ('file','link')
      or payload ? 'owner'
      or payload ? 'ownerId' then
      return false;
    end if;
    if payload ? 'filename'
      and (jsonb_typeof(payload->'filename') is distinct from 'string'
        or length(payload->>'filename') not between 1 and 255) then
      return false;
    end if;
    if payload ? 'mime'
      and (jsonb_typeof(payload->'mime') is distinct from 'string'
        or length(payload->>'mime') not between 1 and 200) then
      return false;
    end if;
    if payload ? 'removing' and jsonb_typeof(payload->'removing') is distinct from 'boolean' then
      return false;
    end if;
    if payload ? 'bytes' then
      if jsonb_typeof(payload->'bytes') is distinct from 'number'
        or payload->>'bytes' !~ '^[0-9]+$' then
        return false;
      end if;
      bytes_value := (payload->>'bytes')::numeric;
      if bytes_value < 0
        or bytes_value <> trunc(bytes_value)
        or bytes_value > 9007199254740991
        or (payload->>'kind' = 'file' and bytes_value > 26214400) then
        return false;
      end if;
    end if;
    if payload->>'kind' = 'file' then
      return not payload ? 'url';
    end if;
    return payload ? 'url'
      and jsonb_typeof(payload->'url') = 'string'
      and length(payload->>'url') <= 4096
      and payload->>'url' ~* '^https?://';
  end if;

  return false;
end;
$$;
revoke all on function desk_private.valid_prep_payload(text,text,jsonb) from public, anon, authenticated;

create or replace function desk_private.prep_storage_allowed(
  object_bucket text,
  object_name text,
  require_uploadable boolean
) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    object_bucket <> 'desk-prep-files'
    or (
      (select auth.uid()) is not null
      and split_part(object_name,'/',1) = (select auth.uid())::text
      and array_length(string_to_array(object_name,'/'),1) = 2
      and split_part(object_name,'/',2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and exists (
        select 1
        from public.desk_entities material
        where material.user_id = (select auth.uid())
          and material.kind = 'prepMaterials'
          and lower(material.id) = lower(split_part(object_name,'/',2))
          and not material.deleted
          and material.payload->>'kind' = 'file'
          and (not require_uploadable or material.payload->>'removing' is distinct from 'true')
      )
    );
$$;
revoke all on function desk_private.prep_storage_allowed(text,text,boolean) from public, anon;
grant execute on function desk_private.prep_storage_allowed(text,text,boolean) to authenticated;

alter table public.desk_entities
  add constraint desk_prep_payload_valid check (
    deleted
    or kind not in ('prepTasks','prepMaterials')
    or desk_private.valid_prep_payload(kind,id,payload) is true
  );

create or replace function desk_private.desk_commit(operation_id uuid, changes jsonb) returns jsonb
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
    and e.kind in ('assessments','results','materials','prepTasks','prepMaterials') and not exists(
      select 1 from public.desk_entities t where t.user_id=uid and t.kind='terms'
        and t.id=e.payload->>'termId' and not t.deleted)) then
    raise exception 'Missing term reference' using errcode='23503';
  end if;
  -- Prep records retain the subject identity after a course is legitimately removed from a term's live course list.
  if exists(select 1 from public.desk_entities e where e.user_id=uid and not e.deleted
    and e.kind in ('prepTasks','prepMaterials') and not exists(
      select 1 from public.desk_entities s where s.user_id=uid and s.kind='subjects'
        and s.id=e.payload->>'courseId' and s.payload->>'track'='school' and not s.deleted)) then
    raise exception 'Missing prep course reference' using errcode='23503';
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

insert into storage.buckets (id,name,public,file_size_limit)
values ('desk-prep-files','desk-prep-files',false,26214400)
on conflict (id) do update
  set public = false,
      file_size_limit = 26214400;

-- Storage can authorize before streaming and finish under its service role.
-- Serialize the actual object insert with desk_commit's deletion marker.
create function desk_private.guard_prep_object_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  path_owner uuid;
  caller uuid := auth.uid();
  file_id text := split_part(new.name,'/',2);
begin
  if new.name !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
    raise exception 'New row violates row-level security for prep file' using errcode='42501';
  end if;
  path_owner := split_part(new.name,'/',1)::uuid;
  if (caller is not null or current_setting('role',true) in ('anon','authenticated'))
    and caller is distinct from path_owner then
    raise exception 'New row violates row-level security for prep file' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(path_owner::text,0));
  if not exists (
    select 1 from public.desk_entities material
    where material.user_id = path_owner
      and material.kind = 'prepMaterials'
      and lower(material.id) = file_id
      and not material.deleted
      and material.payload->>'kind' = 'file'
      and material.payload->>'removing' is distinct from 'true'
  ) then
    raise exception 'New row violates row-level security for prep file' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function desk_private.guard_prep_object_insert() from public, anon, authenticated;

create trigger desk_prep_object_insert_guard
  before insert on storage.objects
  for each row when (new.bucket_id = 'desk-prep-files')
  execute function desk_private.guard_prep_object_insert();

drop policy if exists desk_prep_files_select on storage.objects;
create policy desk_prep_files_select on storage.objects
  for select to authenticated
  using (bucket_id = 'desk-prep-files');

drop policy if exists desk_prep_files_insert on storage.objects;
create policy desk_prep_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'desk-prep-files');

drop policy if exists desk_prep_files_delete on storage.objects;
create policy desk_prep_files_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'desk-prep-files');

-- This restrictive policy prevents a shared permissive Storage policy from opening the prep bucket.
drop policy if exists desk_prep_files_owner_guard on storage.objects;
create policy desk_prep_files_owner_guard on storage.objects
  as restrictive
  for all to authenticated
  using (desk_private.prep_storage_allowed(bucket_id,name,false))
  with check (desk_private.prep_storage_allowed(bucket_id,name,true));

drop policy if exists desk_prep_files_anonymous_guard on storage.objects;
create policy desk_prep_files_anonymous_guard on storage.objects
  as restrictive
  for all to anon
  using (bucket_id <> 'desk-prep-files')
  with check (bucket_id <> 'desk-prep-files');

drop policy if exists desk_prep_files_immutable_guard on storage.objects;
create policy desk_prep_files_immutable_guard on storage.objects
  as restrictive
  for update to public
  using (bucket_id <> 'desk-prep-files')
  with check (bucket_id <> 'desk-prep-files');

commit;
