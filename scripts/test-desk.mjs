import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { academic, sundayFixture, mondayAt, record, result } from './fixtures/academic.mjs';
import { deskDatabase, userA, userB } from './fixtures/desk-db.mjs';
import { flatten, diff, materialize, equal } from '../src/features/desk/entities.ts';
import { mergePreview, totals } from '../src/features/desk/migration.ts';
import { weeklyAllocation, baselineAt, recommend } from '../src/features/academic/allocation.ts';
import { inputsOf } from '../src/features/academic/model.ts';
import { prepMaterialFileLimit, prepMaterialPath, validatePrepData } from '../src/features/prep/model.ts';
import { assertValid, exportBackup, importBackup } from '../src/features/study/storage.ts';

const seed = () => { const { data } = academic(); return data; };
const prepFixture = () => {
  const data = seed();
  const fileId = '33333333-3333-4333-8333-333333333333';
  data.prepTasks = [{
    id: 'prep-task-1', courseId: 'school-0', termId: 'term-test', week: '2026-12-28',
    title: '复习极限', notes: '整理错题', done: false, position: 0, sourceKey: 'course-import:1',
  }];
  data.prepMaterials = [
    {
      id: fileId, courseId: 'school-0', termId: 'term-test', name: '期中试卷',
      kind: 'file', filename: 'midterm.pdf', mime: 'application/pdf', bytes: 1024,
    },
    {
      id: '44444444-4444-4444-8444-444444444444', courseId: 'school-0', termId: 'term-test',
      name: '课程主页', kind: 'link', url: 'https://example.test/course',
    },
  ];
  return { data, fileId };
};
test('all existing business aggregates round-trip, preserving algorithm inputs and historical configuration', () => {
  for (const original of [seed(), sundayFixture().data]) {
    const rows = flatten(original);
    const restored = materialize(rows);
    assert.equal(equal(flatten(restored),rows),true);
    assert.deepEqual(totals(restored),totals(original));
    const term = original.academic.terms[0];
    const clock = { day: '2027-01-03', minute: 720 };
    const target = baselineAt(inputsOf(original),term,clock,original.academic.otherId).target;
    assert.deepEqual(recommend(restored,restored.academic.terms[0],clock,target),recommend(original,term,clock,target));
    assert.deepEqual(weeklyAllocation(restored,term,'2026-12-28',clock,target),weeklyAllocation(original,term,'2026-12-28',clock,target));
  }
  assert.throws(() => materialize([{kind:'sessions',id:'s',payload:{},ordinal:0,version:1,deleted:false}]), /不完整/);
});
test('prep tasks and material metadata round-trip through entities and backups without weakening historical references', () => {
  const { data, fileId } = prepFixture();
  const original = structuredClone(data);
  const rows = flatten(data);
  const restored = materialize(rows);
  assert.equal(equal(flatten(restored), rows), true);
  assert.deepEqual(restored.prepTasks, original.prepTasks);
  assert.deepEqual(restored.prepMaterials, original.prepMaterials);
  assert.equal(prepMaterialPath(userA, fileId), userA + '/' + fileId);
  assert.equal(prepMaterialFileLimit, 25 * 1024 * 1024);
  assert.deepEqual(importBackup(exportBackup(data)).prepTasks, original.prepTasks);
  assert.equal('prepTasks' in materialize(flatten(seed())), false);

  const unlinked = structuredClone(data);
  unlinked.academic.terms[0].courses = unlinked.academic.terms[0].courses.filter(course => course.subjectId !== 'school-0');
  unlinked.subjects.find(subject => subject.id === 'school-0').archived = true;
  assert.doesNotThrow(() => assertValid(unlinked));

  const extended = structuredClone(data);
  extended.prepTasks[0].week = '2027-03-01';
  assert.doesNotThrow(() => assertValid(extended));

  const tuesday = structuredClone(data);
  tuesday.prepTasks[0].week = '2026-12-29';
  assert.throws(() => assertValid(tuesday), /周一日期/);
  const badDate = structuredClone(data);
  badDate.prepTasks[0].week = '2027-02-29';
  assert.throws(() => assertValid(badDate), /周一日期/);
  const selfCourse = structuredClone(data);
  selfCourse.prepTasks[0].courseId = 'self-0';
  assert.throws(() => assertValid(selfCourse), /校内课程/);
  const noTerm = structuredClone(data);
  noTerm.prepTasks[0].termId = 'missing-term';
  assert.throws(() => assertValid(noTerm), /存在的学期/);
  const fileUrl = structuredClone(data);
  fileUrl.prepMaterials[0].url = 'https://example.test/private.pdf';
  assert.throws(() => validatePrepData(fileUrl, {
    subjects: fileUrl.subjects, terms: fileUrl.academic.terms,
  }), /不得持久化访问 URL/);
});
test('multi-source merge is explicit for same ID edits, uncertain duplicates, courses, budgets and deletion tombstones', () => {
  const a = seed(), b = structuredClone(a);
  b.sessions.push(record('new', 'school-0', 120));
  let preview = mergePreview(a,b);
  assert.equal(preview.conflicts.length,0);
  assert.equal(preview.after.count,1);
  assert.equal(preview.after.minutes,120);
  assert.equal(mergePreview(preview.data,b).added,0);
  b.sessions[0].minutes=121;
  preview = mergePreview(preview.data,b);
  assert.equal(preview.conflicts.length,1);
  const selected = mergePreview(preview.data,b,new Set(),{'sessions/new':'both'});
  assert.equal(selected.after.count,2);
  assert.equal(mergePreview(selected.data,b,new Set(),{'sessions/new':'both'}).after.count,2);
  const clone=structuredClone(a); clone.sessions=[record('second','school-0',120)];
  const first=structuredClone(a); first.sessions=[record('first','school-0',120)];
  assert.equal(mergePreview(first,clone).conflicts.length,1);
  assert.equal(mergePreview(first,clone,new Set(),{'sessions/second':'both'}).after.count,2);
  assert.equal(mergePreview(a,b,new Set(['sessions/new'])).conflicts.length,1);
  assert.equal(mergePreview(a,b,new Set(['sessions/new']),{'sessions/new':'cloud'}).after.count,0);
  b.subjects[0].name='other'; b.settings.buffer=20;
  assert.ok(mergePreview(a,b).conflicts.some(c=>c.key==='settings/current'));
  assert.ok(mergePreview(a,b).conflicts.some(c=>c.key==='subjects/school-0'));
  const longId='s'.repeat(100), collision=seed(), incoming=seed();
  collision.sessions=[record(longId,'school-0',121)];incoming.sessions=[record(longId,'school-0',120)];
  incoming.academic.results=[result('linked','school-0','2026-12-28',80,{sessionId:longId})];
  const both=mergePreview(collision,incoming,new Set(),{['sessions/'+longId]:'both'});
  assert.equal(both.conflicts.length,0);assert.equal(both.data.sessions.length,2);
  assert.ok(both.data.sessions.every(row=>row.id.length<=100));
  assert.notEqual(both.data.academic.results[0].sessionId,longId);
  assert.ok(both.data.sessions.some(row=>row.id===both.data.academic.results[0].sessionId));

});

test('backup deletion history restores without resurrection and live deletion needs explicit confirmation', () => {
  const source = seed(), cloud = seed();
  const tombstone = {kind:'sessions',id:'deleted-backup',ordinal:0,version:2,payload:null,deleted:true};
  let preview = mergePreview(cloud,source,new Set(),{},[tombstone]);
  assert.equal(preview.conflicts.length,0);assert.equal(preview.tombstones.length,1);
  cloud.sessions.push(record('deleted-backup','school-0',10));
  preview=mergePreview(cloud,source,new Set(),{},[tombstone]);
  assert.equal(preview.conflicts.length,1);assert.equal(preview.after.count,1);
  preview=mergePreview(cloud,source,new Set(),{'sessions/deleted-backup':'source'},[tombstone]);
  assert.equal(preview.conflicts.length,0);assert.equal(preview.after.count,0);assert.equal(preview.removed,1);
});

test('backup merge preserves an existing file and its deletion lifecycle', () => {
  const { data: cloud, fileId } = prepFixture();
  const key = 'prepMaterials/' + fileId;
  const tombstone = { kind: 'prepMaterials', id: fileId, ordinal: 0, version: 2, payload: null, deleted: true };
  const source = structuredClone(cloud);
  source.prepMaterials = source.prepMaterials.filter(item => item.id !== fileId);

  for (const choice of [undefined, 'source']) {
    const preview = mergePreview(cloud, source, new Set(), choice ? { [key]: choice } : {}, [tombstone]);
    assert.equal(preview.conflicts[0]?.keepCloudOnly, true);
    assert.deepEqual(preview.tombstones, []);
    assert.equal(preview.removed, 0);
    assert.deepEqual(preview.data.prepMaterials, cloud.prepMaterials);
  }
  const keep = mergePreview(cloud, source, new Set(), { [key]: 'cloud' }, [tombstone]);
  assert.equal(keep.conflicts.length, 0);
  assert.deepEqual(keep.data.prepMaterials, cloud.prepMaterials);
  assert.deepEqual(mergePreview(source, source, new Set(), {}, [tombstone]).tombstones, [tombstone]);

  const link = structuredClone(cloud);
  link.prepMaterials[0] = {
    id: fileId, termId: 'term-test', courseId: 'school-0', name: '合成链接',
    kind: 'link', url: 'https://example.test/file',
  };
  assert.equal(mergePreview(cloud, link, new Set(), { [key]: 'source' }).conflicts[0]?.keepCloudOnly, true);
  assert.equal(mergePreview(link, cloud, new Set(), { [key]: 'source' }).conflicts[0]?.keepCloudOnly, true);
  assert.deepEqual(mergePreview(source, cloud).data.prepMaterials.find(item => item.id === fileId), cloud.prepMaterials[0]);
  const removing = structuredClone(cloud);
  removing.prepMaterials[0].removing = true;
  assert.equal(mergePreview(removing, cloud, new Set(), { [key]: 'source' }).conflicts[0]?.keepCloudOnly, true);
  assert.equal(mergePreview(cloud, removing, new Set(), { [key]: 'source' }).conflicts[0]?.keepCloudOnly, true);
  const renamed = structuredClone(cloud);
  renamed.prepMaterials[0].name = '合成文件改名';
  assert.deepEqual(mergePreview(cloud, renamed, new Set(), { [key]: 'source' }).data.prepMaterials, renamed.prepMaterials);
});

test('actual PostgreSQL migration, prep references, immutable storage paths, anonymous denial, user isolation, idempotency, CAS and deletion', async () => {
  const { db, as, commit, snapshot } = await deskDatabase();
  try {
    await assert.rejects(snapshot(null), /permission denied/);
    await assert.rejects(commit(null,randomUUID(),[]), /permission denied/);
    const data=seed();
    let rows=await commit(userA,randomUUID(),diff([],data));
    const withPrep=materialize(rows);
    const prep=prepFixture().data;
    withPrep.prepTasks=prep.prepTasks;
    withPrep.prepMaterials=prep.prepMaterials;
    rows=await commit(userA,randomUUID(),diff(rows,withPrep));
    assert.equal(materialize(rows).prepTasks.length,1);
    assert.equal(materialize(rows).prepMaterials.length,2);

    const payloadChecks=await db.query(`select
      desk_private.valid_prep_payload('prepTasks',$1,$2::jsonb) as valid_task,
      desk_private.valid_prep_payload('prepTasks',$3,$4::jsonb) as invalid_null,
      desk_private.valid_prep_payload('prepTasks',$5,$6::jsonb) as invalid_date,
      desk_private.valid_prep_payload('prepTasks',$7,$8::jsonb) as invalid_position,
      desk_private.valid_prep_payload('prepTasks',$9,$10::jsonb) as invalid_format,
      desk_private.valid_prep_payload('prepTasks',$11,$12::jsonb) as invalid_year,
      desk_private.valid_prep_payload('prepMaterials',$13,$14::jsonb) as invalid_kind`,
    [
      withPrep.prepTasks[0].id,JSON.stringify(withPrep.prepTasks[0]),
      'null-fields','{"id":"null-fields","courseId":"school-0","termId":"term-test","week":null,"title":"x","notes":"","done":false,"position":0}',
      'bad-date','{"id":"bad-date","courseId":"school-0","termId":"term-test","week":"2027-02-29","title":"x","notes":"","done":false,"position":0}',
      'bad-position','{"id":"bad-position","courseId":"school-0","termId":"term-test","week":"2026-12-28","title":"x","notes":"","done":false,"position":9007199254740992}',
      'bad-format','{"id":"bad-format","courseId":"school-0","termId":"term-test","week":"not-a-date","title":"x","notes":"","done":false,"position":0}',
      'bad-year','{"id":"bad-year","courseId":"school-0","termId":"term-test","week":"1899-12-25","title":"x","notes":"","done":false,"position":0}',
      '55555555-5555-4555-8555-555555555555',
      '{"id":"55555555-5555-4555-8555-555555555555","courseId":"school-0","termId":"term-test","name":"x","kind":null}',
    ]);
    assert.equal(payloadChecks.rows[0].valid_task,true);
    assert.equal(payloadChecks.rows[0].invalid_null,false);
    assert.equal(payloadChecks.rows[0].invalid_date,false);
    assert.equal(payloadChecks.rows[0].invalid_position,false);
    assert.equal(payloadChecks.rows[0].invalid_format,false);
    assert.equal(payloadChecks.rows[0].invalid_year,false);
    assert.equal(payloadChecks.rows[0].invalid_kind,false);

    await assert.rejects(commit(userA,randomUUID(),[{
      kind:'prepTasks',id:'missing-course',payload:{...withPrep.prepTasks[0],id:'missing-course',courseId:'missing'},
      ordinal:1,version:0,deleted:false,expected:null,
    }]),/Missing prep course reference/);
    await assert.rejects(commit(userA,randomUUID(),[{
      kind:'prepMaterials',id:'55555555-5555-4555-8555-555555555555',
      payload:{...withPrep.prepMaterials[0],id:'55555555-5555-4555-8555-555555555555',termId:'missing-term'},
      ordinal:2,version:0,deleted:false,expected:null,
    }]),/Missing term reference/);
    await assert.rejects(commit(userA,randomUUID(),[{
      kind:'prepTasks',id:'tuesday',payload:{...withPrep.prepTasks[0],id:'tuesday',week:'2026-12-29'},
      ordinal:1,version:0,deleted:false,expected:null,
    }]),/desk_prep_payload_valid/);

    const unlinked=materialize(rows);
    unlinked.academic.terms[0].courses=unlinked.academic.terms[0].courses.filter(course=>course.subjectId!=='school-0');
    rows=await commit(userA,randomUUID(),diff(rows,unlinked));
    assert.equal(materialize(rows).prepTasks[0].courseId,'school-0');
    await assert.rejects(commit(userA,randomUUID(),[{
      kind:'terms',id:'term-test',payload:null,ordinal:0,version:rows.find(row=>row.kind==='terms').version,
      deleted:true,expected:rows.find(row=>row.kind==='terms').version,
    }]),/Missing term reference/);

    const pendingFileId=randomUUID();
    const removingFileId=randomUUID();
    const withPendingMaterials=materialize(rows);
    withPendingMaterials.prepMaterials.push(
      {
        id:pendingFileId,courseId:'school-0',termId:'term-test',name:'待上传文件',kind:'file',
        filename:'pending.pdf',mime:'application/pdf',bytes:512,
      },
      {
        id:removingFileId,courseId:'school-0',termId:'term-test',name:'删除中文件',kind:'file',
        filename:'removing.pdf',mime:'application/pdf',bytes:512,removing:true,
      },
    );
    rows=await commit(userA,randomUUID(),diff(rows,withPendingMaterials));
    const withoutPending=materialize(rows);
    withoutPending.prepMaterials=withoutPending.prepMaterials.filter(item=>item.id!==pendingFileId);
    rows=await commit(userA,randomUUID(),diff(rows,withoutPending));

    assert.deepEqual(await snapshot(userB),[]);
    assert.equal((await as(userB,'select * from public.desk_entities')).rows.length,0);
    for (const user of [null,userA,userB]) {
      await assert.rejects(as(user,'delete from public.desk_entities'), /permission denied/);
      await assert.rejects(as(user,'update public.desk_entities set deleted=true'), /permission denied/);
      await assert.rejects(as(user,'select * from public.desk_operations'), /permission denied/);
    }
    const before=materialize(rows); before.sessions.push(record('shared','school-0',120));
    const changes=diff(rows,before); const id=randomUUID();
    rows=await commit(userA,id,changes);
    assert.equal(materialize(rows).sessions.length,1);
    assert.deepEqual(await commit(userA,id,changes),rows);
    await assert.rejects(commit(userA,id,[]),/Invalid operation/);
    await assert.rejects(commit(userA,id,[{...changes[0],payload:{}}]),/reused/);
    assert.equal(materialize(await snapshot(userA)).sessions[0].minutes,120);
    const stale=rows;
    const edit=materialize(rows); edit.sessions[0].minutes=121;
    rows=await commit(userA,randomUUID(),diff(rows,edit));
    edit.sessions[0].minutes=122;
    await assert.rejects(commit(userA,randomUUID(),diff(stale,edit)),/changed or deleted/);
    const removed=materialize(rows); removed.sessions=[];
    rows=await commit(userA,randomUUID(),diff(rows,removed));
    await assert.rejects(commit(userA,randomUUID(),changes),/changed or deleted/);
    assert.throws(()=>diff(rows,before),/已在云端删除/);
    const invalid=materialize(rows); invalid.sessions.push(record('broken','school-0',10));
    const batch=diff(rows,invalid); batch[0].payload.subjectId='missing';
    await assert.rejects(commit(userA,randomUUID(),batch),/Missing course/);
    assert.deepEqual(await snapshot(userA),rows);
    const timer=materialize(rows); timer.timer={id:'timer',subjectId:'school-0',day:'2027-01-03',startedAt:mondayAt,elapsedMs:0,runningSince:null};
    rows=await commit(userA,randomUUID(),diff(rows,timer));
    const save=materialize(rows); save.sessions.push(record('timer','school-0',2,'2027-01-03'));save.timer=null;
    rows=await commit(userA,randomUUID(),diff(rows,save));
    assert.equal(materialize(rows).timer,null);
    assert.equal(materialize(rows).sessions[0].id,'timer');
    await assert.rejects(commit(userA,randomUUID(),[{kind:'timer',id:'current',payload:timer.timer,expected:rows.find(x=>x.kind==='timer').version,deleted:false}]),/already saved/);
    // The API takes ownership from auth.uid, not a supplied user_id.
    await commit(userB,randomUUID(),diff([],seed()).map(row=>({...row,user_id:userA})));
    assert.equal(materialize(await snapshot(userA)).sessions.length,1);
    assert.equal(materialize(await snapshot(userB)).sessions.length,0);
    rows=await commit(userA,randomUUID(),[{kind:'sessions',id:'restored-tombstone',ordinal:0,payload:null,expected:null,deleted:true}]);
    assert.ok(rows.some(row=>row.id==='restored-tombstone'&&row.deleted));
    await assert.rejects(commit(userA,randomUUID(),[{kind:'sessions',id:'restored-tombstone',ordinal:0,payload:record('restored-tombstone','school-0',1),expected:null,deleted:false}]),/changed or deleted/);
    const flags=await db.query("select relname,relrowsecurity from pg_class where relname in ('desk_entities','desk_operations')");
    assert.ok(flags.rows.every(row=>row.relrowsecurity));
    assert.ok(rows.some(row=>row.kind==='sessions'&&row.id==='shared'&&row.deleted));

    const bucket=await db.query("select public,file_size_limit from storage.buckets where id='desk-prep-files'");
    assert.deepEqual(bucket.rows[0],{public:false,file_size_limit:26214400});
    const policies=await db.query("select policyname,cmd from pg_policies where schemaname='storage' and tablename='objects' order by policyname");
    assert.deepEqual(Object.fromEntries(policies.rows.map(row=>[row.policyname,row.cmd])),{
      desk_prep_files_delete:'DELETE',
      desk_prep_files_anonymous_guard:'ALL',
      desk_prep_files_immutable_guard:'UPDATE',
      desk_prep_files_insert:'INSERT',
      desk_prep_files_owner_guard:'ALL',
      desk_prep_files_select:'SELECT',
    });
    await db.query(`create policy test_shared_permissive on storage.objects as permissive for all to public
      using(true) with check(true)`);
    const confirmedFileId=withPrep.prepMaterials.find(item=>item.kind==='file').id;
    const linkId=withPrep.prepMaterials.find(item=>item.kind==='link').id;
    await as(userA,'insert into storage.objects(bucket_id,name) values($1,$2)',['desk-prep-files',userA+'/'+confirmedFileId]);
    assert.equal((await as(userA,'select * from storage.objects')).rows.length,1);
    assert.equal((await as(userB,'select * from storage.objects')).rows.length,0);
    assert.equal((await as(null,'select * from storage.objects')).rows.length,0);
    await assert.rejects(as(null,'insert into storage.objects(bucket_id,name) values($1,$2)',[
      'desk-prep-files',userA+'/'+confirmedFileId,
    ]),/row-level security/i);
    const changed=await as(userA,"update storage.objects set name=name||'-changed' where bucket_id='desk-prep-files'");
    assert.equal(changed.rows.length,0);
    assert.equal((await db.query("select count(*)::int as count from storage.objects where name like '%-changed'")).rows[0].count,0);
    await assert.rejects(as(userA,'insert into storage.objects(bucket_id,name) values($1,$2)',[
      'desk-prep-files',userB+'/'+randomUUID(),
    ]),/row-level security/i);
    await assert.rejects(as(userA,'insert into storage.objects(bucket_id,name) values($1,$2)',[
      'desk-prep-files',userA+'/'+linkId,
    ]),/row-level security/i);
    await assert.rejects(as(userA,'insert into storage.objects(bucket_id,name) values($1,$2)',[
      'desk-prep-files',userA+'/'+pendingFileId,
    ]),/row-level security/i);
    await assert.rejects(as(userA,'insert into storage.objects(bucket_id,name) values($1,$2)',[
      'desk-prep-files',userA+'/'+removingFileId,
    ]),/row-level security/i);
    await as(userB,'delete from storage.objects');
    assert.equal((await db.query('select * from storage.objects')).rows.length,1);
    await db.query("insert into storage.buckets(id,name,public) values('other-bucket','other-bucket',false)");
    await as(userA,'insert into storage.objects(bucket_id,name) values($1,$2)',['other-bucket','unrelated/file.pdf']);
    await as(null,'insert into storage.objects(bucket_id,name) values($1,$2)',['other-bucket','anonymous/file.pdf']);
    assert.equal((await db.query("select count(*)::int as count from storage.objects where bucket_id='other-bucket'")).rows[0].count,2);
    const deleting=materialize(rows);
    deleting.prepMaterials.find(item=>item.id===confirmedFileId).removing=true;
    rows=await commit(userA,randomUUID(),diff(rows,deleting));
    await as(userA,'delete from storage.objects where bucket_id=$1 and name=$2',['desk-prep-files',userA+'/'+confirmedFileId]);
    assert.equal((await db.query("select count(*)::int as count from storage.objects where bucket_id='desk-prep-files'")).rows[0].count,0);
    const objectPath = userA + '/' + confirmedFileId;
    const finishUpload = () => db.query('insert into storage.objects(bucket_id,name) values($1,$2)', ['desk-prep-files', objectPath]);
    // The final Storage write can run as a service role, so a late upload must also be rejected outside RLS.
    await assert.rejects(finishUpload(), /row-level security/i);
    const deletedFile = materialize(rows);
    deletedFile.prepMaterials = deletedFile.prepMaterials.filter(item => item.id !== confirmedFileId);
    rows = await commit(userA, randomUUID(), diff(rows, deletedFile));
    assert.ok(rows.some(row => row.kind === 'prepMaterials' && row.id === confirmedFileId && row.deleted));
    await assert.rejects(finishUpload(), /row-level security/i);
  } finally { await db.close(); }
});
