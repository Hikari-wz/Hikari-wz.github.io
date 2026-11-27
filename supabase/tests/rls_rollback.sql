-- Run as the project's SQL administrator. Every synthetic user and record is rolled back.
begin;
select set_config('desk_test.user_a',gen_random_uuid()::text,true);
select set_config('desk_test.user_b',gen_random_uuid()::text,true);
insert into auth.users(id) values (current_setting('desk_test.user_a')::uuid),(current_setting('desk_test.user_b')::uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('desk_test.user_a'),true);
select public.desk_commit(gen_random_uuid(),'[{"kind":"settings","id":"current","payload":{"timezone":"Asia/Shanghai","buffer":10,"ratios":{"normal":[35,50,15],"prepare":[50,35,15],"review":[65,25,10],"sprint":[90,10,0],"vacation":[10,65,25]},"override":"auto","vacation":false,"untimedExam":"endOfDay"},"ordinal":0,"version":0,"deleted":false,"expected":null},{"kind":"timer","id":"current","payload":null,"ordinal":0,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"school-0","payload":{"id":"school-0","name":"高等数学","track":"school","archived":false},"ordinal":0,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"school-1","payload":{"id":"school-1","name":"大学英语","track":"school","archived":false},"ordinal":1,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"school-2","payload":{"id":"school-2","name":"C 语言","track":"school","archived":false},"ordinal":2,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"school-3","payload":{"id":"school-3","name":"其他课程","track":"school","archived":false},"ordinal":3,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"self-0","payload":{"id":"self-0","name":"C++","track":"self","archived":false},"ordinal":4,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"self-1","payload":{"id":"self-1","name":"算法","track":"self","archived":false},"ordinal":5,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"self-2","payload":{"id":"self-2","name":"Python","track":"self","archived":false},"ordinal":6,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"self-3","payload":{"id":"self-3","name":"英语","track":"self","archived":false},"ordinal":7,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"self-4","payload":{"id":"self-4","name":"其他","track":"self","archived":false},"ordinal":8,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"project-0","payload":{"id":"project-0","name":"Hikari’s Space","track":"project","archived":false},"ordinal":9,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"project-1","payload":{"id":"project-1","name":"QQ 待办助手","track":"project","archived":false},"ordinal":10,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"project-2","payload":{"id":"project-2","name":"个人软件","track":"project","archived":false},"ordinal":11,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"project-3","payload":{"id":"project-3","name":"其他项目","track":"project","archived":false},"ordinal":12,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"academic-history","payload":{"id":"academic-history","name":"中国近代史纲要","track":"school","archived":false},"ordinal":13,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"academic-intro","payload":{"id":"academic-intro","name":"计算机导论","track":"school","archived":false},"ordinal":14,"version":0,"deleted":false,"expected":null},{"kind":"subjects","id":"academic-health","payload":{"id":"academic-health","name":"大学生心理健康","track":"school","archived":false},"ordinal":15,"version":0,"deleted":false,"expected":null},{"kind":"sessions","id":"synthetic-rls-session","payload":{"id":"synthetic-rls-session","subjectId":"school-0","day":"2026-11-27","minutes":120,"quality":"","note":"Synthetic rollback-only isolation test"},"ordinal":0,"version":0,"deleted":false,"expected":null},{"kind":"academic","id":"current","payload":{"currentTerm":"","otherId":"school-3","aliases":[{"subjectId":"school-2","name":"程序设计"}],"next":null},"ordinal":0,"version":0,"deleted":false,"expected":null},{"kind":"versions","id":"current","payload":[],"ordinal":0,"version":0,"deleted":false,"expected":null}]'::jsonb);
do $$ begin
  if (select count(*) from public.desk_entities where kind='sessions') <> 1 then raise exception 'Owner read failed'; end if;
end $$;
select set_config('request.jwt.claim.sub',current_setting('desk_test.user_b'),true);
do $$ begin
  if public.desk_snapshot() <> '[]'::jsonb then raise exception 'Cross-account RPC read leak'; end if;
  if (select count(*) from public.desk_entities) <> 0 then raise exception 'Cross-account direct read leak'; end if;
  begin
    update public.desk_entities set deleted=true where user_id=current_setting('desk_test.user_a')::uuid;
    raise exception 'Cross-account direct update unexpectedly allowed';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.desk_entities where user_id=current_setting('desk_test.user_a')::uuid;
    raise exception 'Cross-account direct delete unexpectedly allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.desk_commit(gen_random_uuid(),'[{"kind":"sessions","id":"synthetic-rls-session","ordinal":0,"expected":1,"deleted":true,"payload":null}]'::jsonb);
    raise exception 'Cross-account RPC mutation unexpectedly allowed';
  exception when serialization_failure then null; end;
end $$;
select set_config('request.jwt.claim.sub',current_setting('desk_test.user_a'),true);
do $$ begin
  if (select count(*) from public.desk_entities where kind='sessions' and not deleted) <> 1 then raise exception 'Owner data changed by other account'; end if;
end $$;
reset role;
rollback;
select 'PASS: actual project PostgreSQL role/claims isolation; all synthetic users and records rolled back' as verification;
