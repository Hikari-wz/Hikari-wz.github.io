import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, devices } from 'playwright-core';
import { deskDatabase, userA, userB } from './fixtures/desk-db.mjs';
import { academic, record } from './fixtures/academic.mjs';
import { diff, materialize } from '../src/features/desk/entities.ts';
import { testPrepBrowser } from './test-prep-browser.mjs';

const database=await deskDatabase();
await database.commit(userA,randomUUID(),diff([],academic().data));
const jwt = id => [Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),
  Buffer.from(JSON.stringify({sub:id,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+86400})).toString('base64url'),'test-signature'].join('.');
const byUser=new Map([[userA,jwt(userA)],[userB,jwt(userB)]]);
const tokens=new Map([...byUser].map(([id,token])=>[token,id]));
const user = id => ({id,aud:'authenticated',role:'authenticated',email:id===userA?'a@example.test':'b@example.test',
  app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()});
const mime={html:'text/html',js:'text/javascript',css:'text/css',png:'image/png',svg:'image/svg+xml',webmanifest:'application/manifest+json'};
let failRead=false, loseResponse=false, commits=0;
const files = new Map();
const prepBucket = '/storage/v1/object/desk-prep-files';
async function storage(req, res, url, send) {
  const owner = tokens.get(req.headers.authorization?.replace('Bearer ', ''));
  if (!owner) return send(401, { message: 'unauthorized' });
  const path = url.pathname.slice(prepBucket.length + 1);
  const own = key => key.startsWith(owner + '/') && /^[0-9a-f-]+$/.test(key.split('/')[1] ?? '') && key.split('/').length === 2;
  if (req.method === 'GET') {
    if (!own(path) || !files.has(path)) return send(404, { statusCode: '404', message: 'Object not found' });
    const file = files.get(path);
    res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' }).end(file.bytes);
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (req.method === 'DELETE') {
    const { prefixes } = JSON.parse(body);
    if (prefixes.some(key => !own(key))) return send(403, { message: 'forbidden' });
    const removed = prefixes.filter(key => files.delete(key));
    return send(200, removed.map(name => ({ name })));
  }
  if (req.method !== 'POST' || !own(path)) return send(403, { message: 'forbidden' });
  if (files.has(path)) return send(409, { statusCode: '409', message: 'The resource already exists' });
  const request = new Request(url, {
    method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body,
  });
  const form = await request.formData();
  const file = [...form.values()].find(entry => entry instanceof Blob);
  files.set(path, { bytes: Buffer.from(await file.arrayBuffer()), type: file.type });
  return send(200, { Key: 'desk-prep-files/' + path, Id: randomUUID() });
}
const server=createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','authorization,apikey,content-type,x-client-info,x-upsert');
  if(req.method==='OPTIONS') {res.writeHead(200).end();return;}
  const url=new URL(req.url,'http://localhost');
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify(data));};
  try {
    if (url.pathname === prepBucket || url.pathname.startsWith(prepBucket + '/')) {
      return await storage(req, res, url, send);
    }
    if(url.pathname.startsWith('/auth/v1/')) {
      let raw='';for await(const chunk of req)raw+=chunk;
      const input=raw?JSON.parse(raw):{};
      if(url.pathname.endsWith('/token')) {
        const id=input.email==='a@example.test'?userA:userB;
        if(input.password!=='synthetic-password') return send(400,{message:'Invalid login credentials'});
        return send(200,{access_token:byUser.get(id),refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:86400,user:user(id)});
      }
      if(url.pathname.endsWith('/logout')) return send(200,{});
      if(url.pathname.endsWith('/user')) {
        const id=tokens.get(req.headers.authorization?.replace('Bearer ',''));
        return id?send(200,user(id)):send(401,{message:'unauthorized'});
      }
    }
    if(url.pathname.startsWith('/rest/v1/')) {
      const id=tokens.get(req.headers.authorization?.replace('Bearer ',''));
      if(!id) { console.log('API AUTH FAILED',url.pathname); return send(401,{code:'42501',message:'unauthorized'}); }
      if(failRead && url.pathname.endsWith('/desk_snapshot'))return send(503,{message:'synthetic outage'});
      let raw='';for await(const chunk of req)raw+=chunk;
      const input=raw?JSON.parse(raw):{};
      if(url.pathname.endsWith('/desk_commit')) {
        commits++;
        const data=await database.commit(id,input.operation_id,input.changes);
        if(loseResponse) {loseResponse=false;req.socket.destroy();return;}
        return send(200,data);
      }
      if(url.pathname.endsWith('/desk_snapshot'))return send(200,await database.snapshot(id));
    }
    const path=url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname;
    const bytes=await readFile(join('dist-cloud',path));
    res.writeHead(200,{'Content-Type':mime[path.split('.').pop()]??'application/octet-stream','Cache-Control':'no-store'}).end(bytes);
  }catch(error){if(url.pathname.startsWith('/rest/'))console.log('Expected API rejection:',error.code??'error');send(error.code?400:404,{code:error.code,message:error.message});}
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port;
async function build() {
  const child=spawn(process.execPath,['node_modules/astro/bin/astro.mjs','build','--outDir','dist-cloud'],{env:{...process.env,
    ASTRO_TELEMETRY_DISABLED:'1',PUBLIC_DESK_DATA_MODE:'cloud',PUBLIC_SUPABASE_URL:base,PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic'}});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const [code]=await once(child,'exit');assert.equal(code,0,output);
}
let browser;
try {
  await build();
  browser=await chromium.launch(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{channel:'chrome'});
  const contextA=await browser.newContext({...devices['iPhone 13'],baseURL:base});
  const contextB=await browser.newContext({baseURL:base});
  const a=await contextA.newPage(),b=await contextB.newPage();
  const errors=[];for(const page of [a,b]) {page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(12000);}
  async function login(page,email='a@example.test',route='/desk/study/') {
    await page.goto(route);await page.getByLabel('邮箱',{exact:true}).fill(email);
    await page.getByLabel('密码',{exact:true}).fill('synthetic-password');await page.getByRole('button',{name:'登录',exact:true}).click();
    try { await page.locator('[data-sync]').filter({hasText:'已同步'}).waitFor(); } catch (error) { console.log('LOGIN DEBUG',await page.locator('body').innerText(),errors); throw error; }
  }
  async function open(page,name) {await page.getByRole('navigation',{name:'学习工作台导航'}).getByRole('button',{name,exact:true}).click();}
  async function add(page,minutes) {
    await open(page,'概览');await page.getByRole('button',{name:'快速补录',exact:true}).click();
    const form=page.locator('form[data-form=session]');await form.getByLabel('科目或项目').selectOption('school-0');
    await form.getByLabel('实际时长').fill(String(minutes));await form.getByRole('button',{name:'保存学习记录',exact:true}).click();
    await page.locator('#study-status').filter({hasText:'学习记录已保存'}).waitFor();
  }
  await a.goto('/desk/study/');
  const originalLegacy={format:'hikari-study-dashboard',version:2,data:academic().data};
  await a.evaluate(value=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('hikari-study-dashboard',2);
    request.onupgradeneeded=()=>request.result.createObjectStore('state');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result;const tx=db.transaction('state','readwrite');tx.objectStore('state').put(value,'current');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};
  }),originalLegacy);
  const waiting=await contextA.newPage();
  await waiting.goto('/desk/data/');
  await waiting.getByRole('button',{name:'登录',exact:true}).waitFor();
  await login(a);
  await waiting.getByText('当前账号：a@example.test',{exact:true}).waitFor();
  await waiting.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();
  await waiting.close();
  const preserved=await a.evaluate(()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('hikari-study-dashboard');request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result;const tx=db.transaction('state','readonly');const read=tx.objectStore('state').get('current');tx.oncomplete=()=>{const version=db.version;db.close();resolve({version,value:read.result});};};
  }));
  assert.equal(preserved.version,3);assert.deepEqual(preserved.value,originalLegacy);
  assert.equal(await a.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('hikari-study-dashboard',2);r.onerror=()=>resolve(r.error.name);r.onsuccess=()=>{r.result.close();resolve('unexpected');};})), 'VersionError');
 await login(b,'a@example.test','/desk/academic/');
  await add(a,120);
  await b.reload();await b.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();
  assert.match(await b.locator('[data-academic-content]').textContent(),/2 小时/);
  await open(a,'记录');
  await a.locator('.study-list li').filter({hasText:'高等数学'}).getByRole('button',{name:'编辑',exact:true}).click();
  let form=a.locator('form[data-form=session]');await form.getByLabel('实际时长').fill('121');
  await form.getByRole('button',{name:'保存修改',exact:true}).click();
  await a.locator('#study-status').filter({hasText:'学习记录已保存'}).waitFor();
  assert.equal(materialize(await database.snapshot(userA)).sessions[0].minutes,121);
  await b.reload();await b.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();
  assert.match(await b.locator('[data-academic-content]').textContent(),/2 小时 1 分/);
  a.on('dialog',dialog=>dialog.accept());
  await a.locator('.study-list li').filter({hasText:'高等数学'}).getByRole('button',{name:'删除',exact:true}).click();
  await a.locator('#study-status').filter({hasText:'已删除'}).waitFor();
  await b.reload();await b.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();
  assert.equal(materialize(await database.snapshot(userA)).sessions.length,0);
  assert.doesNotMatch(await b.locator('[data-academic-content]').textContent(),/2 小时 1 分/);
  console.log('Cloud Study add/edit/delete -> independent Academic context verified.');

  // Offline acceptance is durable across a reload, then drains automatically on reconnect.
  await open(a,'概览');await contextA.setOffline(true);await add(a,45);
  await a.locator('[data-sync]').filter({hasText:/离线|失败/}).waitFor();
  await a.reload();await a.locator('[data-sync]').filter({hasText:/离线|失败/}).waitFor();
  await a.locator('#study-content').filter({hasText:'45 分钟'}).waitFor();
  assert.equal(materialize(await database.snapshot(userA)).sessions.length,0);
  await contextA.setOffline(false);
  await a.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();
  assert.equal(materialize(await database.snapshot(userA)).sessions.length,1);
  // Simulate the server committing successfully then dropping the response.
  loseResponse=true;const countBefore=commits;await add(a,10);
  await a.locator('[data-sync]').filter({hasText:/失败|已同步/}).waitFor();
  await a.reload();await a.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();
  assert.ok(commits>=countBefore+2);assert.equal(materialize(await database.snapshot(userA)).sessions.length,2);
  console.log('Durable offline outbox, reload recovery and lost-response idempotency verified.');

  // Cached read failures preserve data; a new device must not initialize an empty authority.
  failRead=true;await a.reload();await a.locator('[data-sync]').filter({hasText:/失败/}).waitFor();
  assert.match(await a.locator('#study-content').textContent(),/55 分钟/);
  const empty=await browser.newContext({baseURL:base});const first=await empty.newPage();
  await first.goto('/desk/study/');await first.getByLabel('邮箱',{exact:true}).fill('a@example.test');
  await first.getByLabel('密码',{exact:true}).fill('synthetic-password');await first.getByRole('button',{name:'登录',exact:true}).click();
  await first.locator('#study-content').filter({hasText:'暂时无法读取云端数据'}).waitFor();
  assert.equal(materialize(await database.snapshot(userA)).sessions.length,2);await empty.close();failRead=false;

  // Offline old edit must conflict with a remote delete, preserving both tombstone and outbox.
  await a.reload();await a.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();await open(a,'记录');
  await contextA.setOffline(true);
  await a.locator('.study-list li').filter({hasText:'45 分'}).getByRole('button',{name:'编辑',exact:true}).click();
  form=a.locator('form[data-form=session]');await form.getByLabel('实际时长').fill('46');await form.getByRole('button',{name:'保存修改',exact:true}).click();
  await a.locator('#study-status').filter({hasText:'学习记录已保存'}).waitFor();
  const remoteRows=await database.snapshot(userA);const remote=materialize(remoteRows);remote.sessions=remote.sessions.filter(row=>row.minutes!==45);
  await database.commit(userA,randomUUID(),diff(remoteRows,remote));
  await contextA.setOffline(false);await a.locator('[data-sync]').filter({hasText:'存在冲突'}).waitFor();
  assert.equal(materialize(await database.snapshot(userA)).sessions.length,1);
  await a.reload();await a.locator('[data-sync]').filter({hasText:'存在冲突'}).waitFor();
  await open(a,'记录');
  assert.match(await a.locator('#study-content').textContent(),/46 分/);
  console.log('Read-failure protection and deletion-vs-offline-edit conflict retention verified.');

  // Export outbox before discarding; migration can ingest it without sending raw stale RPCs.
  await a.goto('/desk/data/');await a.locator('[data-sync]').filter({hasText:'存在冲突'}).waitFor();
  await a.getByText('处理被阻止的待同步操作',{exact:true}).click();
  const outboxDownload=a.waitForEvent('download');await a.getByRole('button',{name:'导出并放弃待同步修改'}).click();
  const outbox=await outboxDownload;assert.match(outbox.suggestedFilename(),/outbox/);
  await a.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();
  const downloadPromise=a.waitForEvent('download');await a.getByRole('button',{name:'导出完整云端备份'}).click();
  const download=await downloadPromise;
  const backup=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.ok(backup.rows.some(row=>row.deleted));assert.equal(backup.sha256.length,64);
  // Multi-source preview and idempotent repeat import from real UI.
  const source=materialize(await database.snapshot(userA));source.sessions.push(record('migration-new','school-0',30));
  const payload=JSON.stringify({format:'hikari-study-dashboard',version:2,exportedAt:new Date().toISOString(),data:source});
  await a.locator('[data-source]').setInputFiles({name:'source.json',mimeType:'application/json',buffer:Buffer.from(payload)});
  await a.getByRole('button',{name:'确认合并到云端'}).waitFor();
  await a.getByRole('button',{name:'确认合并到云端'}).click();
  await a.locator('[data-message]').filter({hasText:'云端确认'}).waitFor();
  assert.equal(materialize(await database.snapshot(userA)).sessions.length,2);
  await a.locator('[data-source]').setInputFiles({name:'source2.json',mimeType:'application/json',buffer:Buffer.from(payload)});
  await a.getByRole('button',{name:'确认合并到云端'}).click();await a.locator('[data-message]').filter({hasText:'云端确认'}).waitFor();
  assert.equal(materialize(await database.snapshot(userA)).sessions.length,2);
  console.log('Migration UI, reconciliation totals, repeated import and complete cloud backup verified.');

  // Restoring the complete cloud backup into another account preserves deletion history too.
  const fresh=await browser.newContext({baseURL:base});const restorePage=await fresh.newPage();
  await login(restorePage,'b@example.test','/desk/data/');
  await restorePage.locator('[data-source]').setInputFiles({name:'cloud.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await restorePage.getByRole('button',{name:'确认合并到云端'}).waitFor();
  while (await restorePage.locator('[data-preview] select').count()) {
    const select=restorePage.locator('[data-preview] select').first();
    await select.locator('..').locator('summary').click();await select.selectOption('source');
  }
  if (await restorePage.getByRole('button',{name:'确认合并到云端'}).isDisabled()) console.log('RESTORE CONFLICTS',await restorePage.locator('[data-preview] summary').allTextContents());
  await restorePage.getByRole('button',{name:'确认合并到云端'}).click();
  await restorePage.locator('[data-message]').filter({hasText:'云端确认'}).waitFor();
  assert.ok((await database.snapshot(userB)).some(row=>row.deleted));
  assert.equal(materialize(await database.snapshot(userB)).sessions.length,1);await fresh.close();
  // Timer timestamp state survives reopening and another context sees the identical stable id.
  await a.goto('/desk/study/');await a.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();await open(a,'记录');
  await a.locator('form[data-form=timer]').getByLabel('科目或项目').selectOption('school-0');
  await a.locator('form[data-form=timer]').getByRole('button',{name:'开始计时',exact:true}).click();
  await a.locator('#study-status').filter({hasText:'计时已开始'}).waitFor();
  const timerId=materialize(await database.snapshot(userA)).timer.id;
  await b.goto('/desk/study/');await b.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();await open(b,'记录');
  await b.getByRole('button',{name:'暂停',exact:true}).waitFor();
  await a.reload();await a.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();await open(a,'记录');
  assert.equal(materialize(await database.snapshot(userA)).timer.id,timerId);
  await a.clock.setFixedTime(new Date(Date.now()+120000));
  await a.getByRole('button',{name:'暂停',exact:true}).click();await a.locator('#study-status').filter({hasText:'计时状态已保存'}).waitFor();
  await a.clock.setFixedTime(new Date(Date.now()+120000));
  await a.getByRole('button',{name:'结束并保存',exact:true}).click();
  const finish=a.locator('form[data-form=finish-timer]');await finish.getByLabel('实际时长').fill('2');
  await finish.getByRole('button',{name:'保存计时记录',exact:true}).click();await a.locator('#study-status').filter({hasText:'学习记录已保存'}).waitFor();
  assert.equal(materialize(await database.snapshot(userA)).timer,null);
  assert.equal(materialize(await database.snapshot(userA)).sessions.filter(row=>row.id===timerId).length,1);
  console.log('Legacy v2 fence preserves raw data; cloud disaster restore retains tombstones; shared timer resumes and saves once.');

  await a.getByRole('button',{name:'退出登录',exact:true}).click();await a.getByRole('button',{name:'登录',exact:true}).waitFor();
  assert.doesNotMatch(await a.locator('body').textContent(),/migration-new|55 分钟|46 分/);
  await a.getByLabel('邮箱',{exact:true}).fill('b@example.test');await a.getByLabel('密码',{exact:true}).fill('synthetic-password');
  await a.getByRole('button',{name:'登录',exact:true}).click();await a.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();
  await a.goto('/desk/study/');await a.locator('[data-sync]').filter({hasText:'已同步'}).waitFor();
  assert.match(await a.locator('#study-content').textContent(),/10 分钟/);
  assert.equal(materialize(await database.snapshot(userB)).sessions.length,1);
  assert.deepEqual(errors,[]);
  assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log('Logout privacy, different-account cache isolation and mobile-width layout verified.');
  await testPrepBrowser({ browser, devices, base, login, database, files });
} finally {
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await database.db.close();
}
