import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
export const userA = '11111111-1111-4111-8111-111111111111';
export const userB = '22222222-2222-4222-8222-222222222222';
export async function deskDatabase() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values('${userA}'),('${userB}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;`);
  for (const file of (await readdir('supabase/migrations')).filter(name=>name.endsWith('.sql')).sort()) {
    await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
  }
  async function as(user, sql, params = []) {
    return db.transaction(async tx => {
      await tx.exec('set local role ' + (user ? 'authenticated' : 'anon'));
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user ?? '']);
      return tx.query(sql,params);
    });
  }
  return { db, as,
    snapshot: async user => (await as(user, 'select public.desk_snapshot() as data')).rows[0].data,
    commit: async (user, id, changes) => (await as(user, 'select public.desk_commit($1,$2::jsonb) as data',[id,JSON.stringify(changes)])).rows[0].data };
}
