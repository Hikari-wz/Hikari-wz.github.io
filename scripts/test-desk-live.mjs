// Run only against an empty dedicated test project with two synthetic test accounts.
// No service role key is used. Credentials are read from environment and never printed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { migrateStudy } from '../src/features/academic/model.ts';
import { emptyData } from '../src/features/study/model.ts';
import { diff, materialize } from '../src/features/desk/entities.ts';
const required=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DESK_TEST_EMAIL_A','DESK_TEST_PASSWORD_A','DESK_TEST_EMAIL_B','DESK_TEST_PASSWORD_B'];
if(required.some(name=>!process.env[name]))throw new Error('Missing live-test configuration; see docs/desk-data-setup.md.');
if(process.env.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_secret_'))throw new Error('Secret key forbidden.');
const make=()=>createClient(process.env.SUPABASE_URL,process.env.SUPABASE_PUBLISHABLE_KEY,
  {auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})}});
const anon=make(),a=make(),b=make();
const snapshot=async client=>{const {data,error}=await client.rpc('desk_snapshot');if(error)throw error;return data;};
const commit=async(client,id,changes)=>{const {data,error}=await client.rpc('desk_commit',{operation_id:id,changes});if(error)throw error;return data;};
try {
  for(const [client,suffix] of [[a,'A'],[b,'B']]) {
    const {error}=await client.auth.signInWithPassword({email:process.env['DESK_TEST_EMAIL_'+suffix],password:process.env['DESK_TEST_PASSWORD_'+suffix]});
    if(error)throw new Error('Test account login failed; verify Auth configuration.');
  }
  const uidA=(await a.auth.getSession()).data.session.user.id;
  const uidB=(await b.auth.getSession()).data.session.user.id;
  assert.notEqual(uidA,uidB,'Use two distinct test accounts.');
  assert.deepEqual(await snapshot(a),[],'Refusing to write: account A is not empty. Use a fresh test account.');
  assert.deepEqual(await snapshot(b),[],'Refusing to write: account B is not empty. Use a fresh test account.');
  assert.ok((await anon.rpc('desk_snapshot')).error,'Anonymous snapshot must be denied');
  assert.ok((await anon.from('desk_entities').select('*')).error,'Anonymous direct reads must be denied');
  assert.ok((await anon.rpc('desk_commit',{operation_id:randomUUID(),changes:[]})).error,'Anonymous writes must be denied');
  const sample=migrateStudy(emptyData());
  let rows=await commit(a,randomUUID(),diff([],sample));
  sample.sessions.push({id:'live-'+randomUUID(),subjectId:'school-0',day:'2026-11-27',minutes:120,quality:'',note:'SYNTHETIC RLS TEST'});
  const batch=diff(rows,sample),operation=randomUUID();
  rows=await commit(a,operation,batch);
  assert.deepEqual(await commit(a,operation,batch),rows);
  assert.deepEqual(await snapshot(b),[]);
  const direct=await b.from('desk_entities').select('*').eq('user_id',uidA);assert.ifError(direct.error);assert.deepEqual(direct.data,[]);
  for(const client of [a,b]) {
    assert.ok((await client.from('desk_entities').delete().eq('user_id',uidA)).error,'Direct delete must be denied');
    assert.ok((await client.from('desk_entities').update({deleted:true}).eq('user_id',uidA)).error,'Direct update must be denied');
    assert.ok((await client.from('desk_operations').select('*')).error,'Operation receipts must not be public');
  }
  const prior=rows;
  const update=materialize(rows);update.sessions[0].minutes=121;
  rows=await commit(a,randomUUID(),diff(rows,update));
  const old=materialize(prior);old.sessions[0].minutes=122;
  assert.ok((await a.rpc('desk_commit',{operation_id:randomUUID(),changes:diff(prior,old)})).error);
  assert.ok((await b.rpc('desk_commit',{operation_id:randomUUID(),changes:diff(prior,old).map(c=>({...c,user_id:uidA}))})).error);
  assert.equal(materialize(await snapshot(a)).sessions[0].minutes,121);
  const removed=materialize(rows);removed.sessions=[];
  rows=await commit(a,randomUUID(),diff(rows,removed));
  assert.ok((await a.rpc('desk_commit',{operation_id:randomUUID(),changes:batch})).error);
  assert.equal(materialize(await snapshot(a)).sessions.length,0);
  console.log('PASS: live anonymous denial, cross-account API isolation, denied direct writes, CAS, idempotency and tombstones.');
  console.log('Synthetic records and receipts remain in the dedicated test project; no production data was removed.');
} finally {
  await Promise.allSettled([a.auth.signOut({scope:'local'}),b.auth.signOut({scope:'local'})]);
}
