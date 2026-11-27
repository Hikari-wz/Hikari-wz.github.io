import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { academic, sundayFixture, mondayAt, record, result } from './fixtures/academic.mjs';
import { deskDatabase, userA, userB } from './fixtures/desk-db.mjs';
import { flatten, diff, materialize, equal } from '../src/features/desk/entities.ts';
import { mergePreview, totals } from '../src/features/desk/migration.ts';
import { weeklyAllocation, baselineAt, recommend } from '../src/features/academic/allocation.ts';
import { inputsOf } from '../src/features/academic/model.ts';

const seed = () => { const { data } = academic(); return data; };
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

test('actual PostgreSQL migration, anonymous denial, user isolation, idempotency, CAS, deletion, atomic references', async () => {
  const { db, as, commit, snapshot } = await deskDatabase();
  try {
    await assert.rejects(snapshot(null), /permission denied/);
    await assert.rejects(commit(null,randomUUID(),[]), /permission denied/);
    const data=seed();
    let rows=await commit(userA,randomUUID(),diff([],data));
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
  } finally { await db.close(); }
});
