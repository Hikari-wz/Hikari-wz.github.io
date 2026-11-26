import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, devices } from 'playwright-core';
import ts from 'typescript';
import { backupLimit, exportBackup, exportBackupBlob } from '../src/features/study/storage.ts';
import { instant, largeBackupData, legacy, mondayAt, sunday, sundayFixture, tuesdayAt, wednesday } from './fixtures/academic.mjs';

const study = '/desk/study/';
const academic = '/desk/academic/';
const variants = process.env.ACADEMIC_LEGACY_DIST ? ['current', 'legacy'] : ['current'];
const dist = { current: resolve('dist'), legacy: resolve(process.env.ACADEMIC_LEGACY_DIST ?? 'dist') };
const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json',
  webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png' };
let legacyShell = false;
let blockWorkerUpdate = false;
const workerPath = study + 'sw.js';
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (path === '/__academic-test') return response.setHeader('Content-Type', 'text/html').end('<title>Academic test harness</title>');
    if (/^\/__source\/(study|academic)\/[a-z]+\.ts$/.test(path)) {
      const source = await readFile('src/features/' + path.slice('/__source/'.length), 'utf8');
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } });
      return response.setHeader('Content-Type', mime.js).end(compiled.outputText);
    }
    const file = path.endsWith('/') ? path + 'index.html' : path;
    if (!/^\/[\w./-]+$/.test(file) || file.includes('..')) return response.writeHead(400).end();
    if (path === workerPath && blockWorkerUpdate) return response.writeHead(503).end();
    const order = legacyShell && (path === study || path === workerPath) ? ['legacy', 'current'] : variants;
    for (const version of order) {
      try {
        const bytes = await readFile(dist[version] + file);
        return response.setHeader('Cache-Control', 'no-store')
          .setHeader('Content-Type', mime[file.split('.').at(-1)] ?? 'application/octet-stream').end(bytes);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    response.writeHead(404).end();
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const baseURL = 'http://127.0.0.1:' + port;
const browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chrome' });
const contextOptions = { baseURL, serviceWorkers: 'block', acceptDownloads: true };
const envelope = data => JSON.parse(exportBackup(data));
const at = (page, time) => page.clock.setFixedTime(new Date(time));
const form = (page, id) => page.locator('form[data-form="' + id + '"]');
const button = (page, name) => page.getByRole('button', { name, exact: true });
const nav = (page, name) => button(page.getByRole('navigation', { name: '学业中心导航' }), name).click();
const total = (page, text) => page.locator('[data-academic-total]').filter({ hasText: text }).waitFor();
const alert = (page, selector, text) => page.locator(selector).filter({ hasText: text }).waitFor();
const readStatus = (page, text) => alert(page, '[data-academic-status]', text);
const studyStatus = (page, text) => alert(page, '#study-status', text);
const pickFile = (page, selector, payload) => page.locator(selector).setInputFiles({
  name: 'synthetic-backup.json', mimeType: 'application/json', buffer: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
});
const openSettings = page => button(page, '设置').click();
async function seed(page, data, version = data.academic ? 2 : 1, hold = false) {
  await page.goto('/__academic-test');
  await page.evaluate(async ({ payload, version, hold }) => {
    const db = await new Promise((res, rej) => {
      const request = indexedDB.open('hikari-study-dashboard', version);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => rej(request.error);
      request.onsuccess = () => res(request.result);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(payload, 'current');
      tx.oncomplete = res;
      tx.onabort = () => rej(tx.error);
    });
    if (hold) window.testHold = db;
    else db.close();
  }, { payload: envelope(data), version, hold });
}
const raw = page => page.evaluate(() => new Promise((res, rej) => {
  const request = indexedDB.open('hikari-study-dashboard');
  request.onsuccess = () => {
    const db = request.result;
    const read = db.transaction('state').objectStore('state').get('current');
    read.onsuccess = () => { db.close(); res({ version: db.version, payload: read.result }); };
    read.onerror = () => rej(read.error);
  };
  request.onerror = () => rej(request.error);
}));

try {
  console.log('Chrome ' + browser.version());
  // T01/T02/T10/T13: compiled menus, real forms, same-origin broadcast and local-only writes.
  {
    const ctx = await browser.newContext({ ...contextOptions, ...devices['iPhone 13'] });
    const a = await ctx.newPage();
    const s = await ctx.newPage();
    const errors = [];
    for (const page of [a, s]) {
      page.setDefaultTimeout(8000);
      page.on('pageerror', error => errors.push(error.message));
      await at(page, sunday);
    }
    const { data } = sundayFixture();
    data.sessions = [];
    await seed(a, data);
    await a.goto('/desk/');
    await a.getByRole('link', { name: '打开学业中心' }).click();
    await total(a, '0 分钟');
    await s.goto('/desk/');
    await s.getByRole('link', { name: '打开学习工作台' }).click();
    await s.locator('#study-content[aria-busy=false]').waitFor();
    const quick = form(s, 'session');
    await button(s, '快速补录').click();
    await quick.getByLabel('科目或项目').selectOption('school-0');
    await quick.getByLabel('实际时长').fill('120');
    await button(quick, '保存学习记录').click();
    await studyStatus(s, '学习记录已保存');
    await total(a, '2 小时');
    const note = 'synthetic-record-changed';
    const stale = await ctx.newPage();
    await at(stale, sunday);
    await stale.goto(study);
    for (const page of [s, stale]) {
      await button(page, '记录').click();
      await button(page, '编辑').first().click();
      const fields = form(page, 'session');
      await fields.getByLabel('实际时长').fill('90');
      await fields.locator('summary').click();
      await fields.getByLabel('成果或备注').fill(note);
    }
    await form(stale, 'session').getByLabel('实际时长').fill('55');
    await button(form(s, 'session'), '保存修改').click();
    await studyStatus(s, '学习记录已保存');
    await total(a, '1 小时 30 分');
    await button(form(stale, 'session'), '保存修改').click();
    await studyStatus(stale, '另一个窗口已变更');
    assert.equal((await raw(a)).payload.data.sessions[0].minutes, 90);
    await stale.close();
    const sessions = (await raw(a)).payload.data.sessions;
    const requests = [];
    a.on('request', request => requests.push(request.url()));
    await ctx.setOffline(true);
    await nav(a, '成果');
    const outcome = form(a, 'result');
    await outcome.getByLabel('活动').fill('独立练习');
    await outcome.getByLabel('活动').blur();
    await outcome.getByLabel('独立正确数').fill('6');
    await outcome.getByLabel('总题数').fill('10');
    await outcome.getByLabel('提示后正确（选填）').fill('2');
    await outcome.locator('summary').click();
    await outcome.getByLabel('关联已保存课次').selectOption(sessions[0].id);
    const injection = '<img src="/test-injection" onerror="window.injected=1">';
    await outcome.getByLabel('备注').fill(injection);
    await button(outcome, '保存').click();
    await readStatus(a, '已保存');
    await a.getByText('提示后正确 20%', { exact: false }).waitFor();
    assert.equal(await a.getByText(injection, { exact: true }).count(), 1);
    assert.equal(await a.locator('[src="/test-injection"]').count(), 0);
    await nav(a, '周报');
    await a.getByRole('heading', { name: '学业周报' }).waitFor();
    await nav(a, '设置');
    const reserve = form(a, 'reserve');
    await reserve.getByLabel('机动（%）').fill('4');
    await button(reserve, '保存').click();
    await readStatus(a, '已保存');
    assert.deepEqual(requests, []);
    await ctx.setOffline(false);
    s.once('dialog', dialog => void dialog.accept());
    await button(s, '删除').first().click();
    await studyStatus(s, '学习记录已删除');
    await nav(a, '概览');
    await total(a, '0 分钟');
    assert.equal((await raw(a)).payload.data.academic.results.at(-1).sessionId, '');
    await nav(a, '设置');
    const download = a.waitForEvent('download');
    await button(a, '导出完整 JSON').click();
    const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    assert.equal(exported.version, 2);
    assert.equal(exported.data.academic.terms[0].reserve, .04);
    await pickFile(a, '[data-backup-file]', exportBackup(legacy({ pause: true })));
    await button(a, '确认覆盖并恢复').click();
    await readStatus(a, '完整备份已恢复');
    const restored = (await raw(a)).payload.data;
    assert.equal(restored.sessions.length, 3);
    assert.equal(restored.timer.runningSince, null);
    await nav(a, '设置');
    await pickFile(a, '[data-backup-file]', exported);
    await readStatus(a, '结算当前计时');
    assert.deepEqual((await raw(a)).payload.data, restored);
    await button(s, '记录').click();
    await button(s, '结束并保存').click();
    await button(s.getByRole('dialog'), '保存计时记录').click();
    await studyStatus(s, '学习记录已保存');
    await pickFile(a, '[data-backup-file]', exported);
    await button(a, '确认覆盖并恢复').click();
    await readStatus(a, '完整备份已恢复');
    assert.deepEqual((await raw(a)).payload.data, exported.data);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ ...contextOptions, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const { data } = sundayFixture();
    await at(page, sunday);
    await seed(page, data);
    await page.goto(academic);
    await total(page, '10 小时 50 分');
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['概览', '课程', '日程', '成果', '周报', '设置']) {
        await nav(page, name);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name + ' ' + width);
      }
    }
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('button, a, input, select, textarea, summary')), true);
    await ctx.close();
  }
  console.log('T01/T02/T10/T13 compiled Astro: navigation, responsive checks, concurrent edit, shared total, feedback unlink, offline save/review/settings, escaped text and backup conflict verified.');

  // T08/T09/T14: formal exams, temporary work, paper materials and historical course identity.
  {
    const ctx = await browser.newContext(contextOptions);
    const a = await ctx.newPage();
    await at(a, sunday);
    const { data } = sundayFixture();
    await seed(a, data);
    await a.goto(academic);
    await nav(a, '课程');
    const course = a.locator('[data-keep="course-school-0"]');
    await course.locator(':scope > summary').click();
    await course.locator('[data-keep="materials-school-0"] > summary').click();
    const newItem = course.locator('[data-keep="material-new-school-0"]');
    await newItem.locator('summary').click();
    const paper = form(newItem, 'material-add');
    for (const name of ['合成卷甲', '合成卷乙']) {
      await paper.getByLabel('年份或名称').fill(name);
      await paper.getByLabel('位置提示').fill('纸质夹');
      await paper.getByLabel('用途').selectOption('sealed');
      await button(paper, '保存').click();
      await readStatus(a, '已保存');
    }
    const one = course.locator('details').filter({ has: a.locator('summary').getByText('合成卷甲 · 封存') }).last();
    await one.locator(':scope > summary').click();
    const edit = form(one, 'material');
    await edit.getByLabel('用途').selectOption('mocked');
    await button(edit, '保存').click();
    await readStatus(a, '已保存');
    const coursesSaved = (await raw(a)).payload.data;
    assert.deepEqual(coursesSaved.academic.materials.map(item => item.use), ['mocked', 'sealed']);
    const options = form(course, 'course');
    await options.getByLabel('共享科目名').fill('合成主课新名');
    a.once('dialog', dialog => void dialog.accept());
    await button(options, '保存').click();
    await readStatus(a, '已保存');
    const renamed = (await raw(a)).payload.data;
    assert.equal(renamed.subjects.find(item => item.id === 'school-0').name, '合成主课新名');
    assert.deepEqual(renamed.sessions, data.sessions);
    await nav(a, '日程');
    await a.locator('[data-keep="new-assessment"] > summary').click();
    const event = form(a.locator('[data-keep="new-assessment"]'), 'assessment');
    await event.getByLabel('课程').selectOption(data.academic.otherId);
    await event.getByLabel('标题').fill('合成临时作业');
    await event.getByLabel('截止日或考试日').fill('2027-01-06');
    await button(event, '保存').click();
    await readStatus(a, '已保存');
    await nav(a, '概览');
    await a.getByRole('heading', { name: /合成临时作业/ }).waitFor();
    await nav(a, '日程');
    await a.locator('[data-keep="new-assessment"] > summary').click();
    await event.getByLabel('课程').selectOption('school-0');
    await event.getByLabel('标题').fill('合成正式考试');
    await event.getByLabel('类型').selectOption('exam');
    await event.getByLabel('截止日或考试日').fill('2027-01-06');
    await event.locator('[data-keep="exam-option-new"] > summary').click();
    await event.getByLabel('Study 重要性').selectOption('important');
    a.once('dialog', dialog => void dialog.accept());
    await button(event, '保存').click();
    await readStatus(a, '已保存');
    const newExam = (await raw(a)).payload.data;
    assert.equal(newExam.exams.find(item => item.name === '合成正式考试').importance, 'important');
    assert.deepEqual(newExam.plans, data.plans);
    const s = await ctx.newPage();
    await at(s, sunday);
    await s.goto(study);
    await alert(s, '.study-total', '考前冲刺期');
    await nav(a, '设置');
    await a.locator('[data-keep="term-term-test"] > summary').click();
    a.once('dialog', dialog => void dialog.accept());
    await button(a, '归档学期').click();
    await readStatus(a, '已保存');
    await button(a, '查看此学期').click();
    await nav(a, '周报');
    await a.getByText('合成主课新名', { exact: true }).first().waitFor();
    assert.equal((await raw(a)).payload.data.sessions.length, data.sessions.length);
    await ctx.close();
  }
  console.log('T08/T09/T14 compiled forms: task priority, shared exam, paper index lifecycle, stable rename and archived review.');

  // T03/T04: held connection, aborted upgrade, broken envelope, stale restore and scope isolation.
  {
    const ctx = await browser.newContext(contextOptions);
    const seedPage = await ctx.newPage();
    const a = await ctx.newPage();
    const old = legacy({ duplicate: true });
    await seed(seedPage, old, 1, true);
    await at(a, sunday);
    await a.goto(academic);
    await readStatus(a, '其他窗口占用');
    const unmodified = await seedPage.evaluate(() => new Promise((res, rej) => {
      const db = window.testHold;
      const read = db.transaction('state').objectStore('state').get('current');
      read.onsuccess = () => res({ version: db.version, payload: read.result });
      read.onerror = () => rej(read.error);
    }));
    assert.deepEqual(unmodified, { version: 1, payload: { ...unmodified.payload, data: old } });
    await seedPage.evaluate(() => window.testHold.close());
    await button(a, '重试读取').click();
    await a.getByRole('heading', { name: '开始使用' }).waitFor();
    const upgraded = await raw(a);
    assert.equal(upgraded.version, 2);
    assert.equal(upgraded.payload.data.subjects.find(item => item.id === 'old-c-lab').name, '程序设计');
    assert.equal(upgraded.payload.data.subjects.find(item => item.id === 'school-2').name, '程序设计');
    for (const field of ['sessions', 'plans', 'timer', 'reviews', 'exams', 'settings']) {
      assert.deepEqual(upgraded.payload.data[field], old[field]);
    }
    await a.reload();
    assert.equal((await raw(a)).payload.data.subjects.length, upgraded.payload.data.subjects.length);
    const isolated = await ctx.newPage();
    await at(isolated, sunday);
    await isolated.goto('http://localhost:' + port + academic);
    await isolated.getByRole('heading', { name: '开始使用' }).waitFor();
    assert.equal((await raw(isolated)).payload.data.sessions.length, 0);
    await nav(isolated, '设置');
    await pickFile(isolated, '[data-backup-file]', envelope(old));
    await button(isolated, '确认覆盖并恢复').click();
    await readStatus(isolated, '完整备份已恢复');
    assert.deepEqual((await raw(isolated)).payload.data.sessions, old.sessions);
    await a.goto('/__academic-test');
    const rollback = await a.evaluate(async () => {
      const { openStudyRepository } = await import('/__source/study/storage.ts');
      const repo = await openStudyRepository();
      const before = await repo.read();
      const fail = await repo.update(data => {
        data.sessions[0].minutes = -4;
      }).then(() => '', error => error.message);
      const simulatedQuota = await repo.update(data => {
        data.sessions.pop();
        throw new DOMException('synthetic quota', 'QuotaExceededError');
      }).then(() => '', error => error.name);
      const after = await repo.read();
      repo.close();
      return { fail, simulatedQuota, equal: JSON.stringify(before) === JSON.stringify(after) };
    });
    assert.match(rollback.fail, /无效/);
    assert.equal(rollback.simulatedQuota, 'QuotaExceededError');
    assert.equal(rollback.equal, true);
    await ctx.close();
  }

  for (const schema of [1, 2]) {
    const ctx = await browser.newContext(contextOptions);
    const a = await ctx.newPage();
    await at(a, sunday);
    const broken = schema === 1 ? legacy() : sundayFixture().data;
    broken.sessions[0].minutes = -1;
    await seed(a, broken, schema);
    await a.goto(academic);
    await a.getByRole('heading', { name: '本地数据暂不可用' }).waitFor();
    const before = await raw(a);
    assert.equal(before.version, schema);
    assert.equal(before.payload.data.sessions[0].minutes, -1);
    const good = legacy();
    a.once('dialog', dialog => void dialog.accept());
    await pickFile(a, '[data-recovery-file]', envelope(good));
    await readStatus(a, '损坏的本地快照已保留');
    const restored = await raw(a);
    assert.equal(restored.version, 2);
    assert.deepEqual(restored.payload.data.sessions, good.sessions);
    const quarantined = await a.evaluate(() => new Promise((res, rej) => {
      const request = indexedDB.open('hikari-study-dashboard', 2);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('state').objectStore('state').getAll();
        read.onsuccess = () => { db.close(); res(read.result.filter(item => item.data.sessions[0].minutes === -1).length); };
        read.onerror = () => rej(read.error);
      };
      request.onerror = () => rej(request.error);
    }));
    assert.equal(quarantined, 1);
    await ctx.close();
  }
  console.log('T03/T04: isolated origins, explicit transfer, blocked-upgrade retry, aborted writes and explicit backup recovery with original snapshot retained.');

  if (process.env.ACADEMIC_LEGACY_DIST) {
    for (const staleAction of ['edit', 'finish', 'import']) {
      const ctx = await browser.newContext(contextOptions);
      const oldPage = await ctx.newPage();
      const newPage = await ctx.newPage();
      const old = legacy({ pause: true });
      old.subjects[0].archived = false;
      await at(oldPage, sunday);
      await at(newPage, sunday);
      await seed(oldPage, old, 1);
      legacyShell = true;
      await oldPage.goto(study);
      await oldPage.locator('#study-content[aria-busy=false]').waitFor();
      if (staleAction === 'edit') {
        await button(oldPage, '记录').click();
        await button(oldPage, '编辑').first().click();
        await form(oldPage, 'session').getByLabel('实际时长').fill('91');
      } else if (staleAction === 'finish') {
        await button(oldPage, '记录').click();
        await button(oldPage, '结束并保存').click();
        await oldPage.getByRole('dialog').waitFor();
      } else {
        await openSettings(oldPage);
        await pickFile(oldPage, '#study-backup-file', envelope(old));
        await button(oldPage, '确认覆盖并恢复').waitFor();
      }
      legacyShell = false;
      await newPage.goto(academic);
      await newPage.getByRole('heading', { name: '开始使用' }).waitFor();
      await nav(newPage, '设置');
      const term = form(newPage, 'term');
      await term.getByLabel('名称').fill('栅栏保留合成学期');
      await term.getByLabel('开始日').fill('2026-12-01');
      await term.getByLabel('结束日（含）').fill('2027-01-31');
      await button(term, '创建学期').click();
      await readStatus(newPage, '已保存');
      const before = (await raw(newPage)).payload.data;
      if (staleAction === 'edit') await button(form(oldPage, 'session'), '保存修改').click();
      else if (staleAction === 'finish') await button(oldPage.getByRole('dialog'), '保存计时记录').click();
      else await button(oldPage, '确认覆盖并恢复').click();
      await studyStatus(oldPage, '操作未完成');
      assert.deepEqual((await raw(newPage)).payload.data, before, staleAction);
      await oldPage.reload();
      await button(oldPage, '记录').click();
      await button(oldPage, '结束并保存').click();
      await button(oldPage.getByRole('dialog'), '保存计时记录').click();
      await studyStatus(oldPage, '学习记录已保存');
      const after = (await raw(newPage)).payload.data;
      assert.equal(after.sessions.filter(row => row.id === old.timer.id).length, 1);
      assert.equal(after.timer, null);
      assert.deepEqual(after.academic.terms, before.academic.terms);
      await ctx.close();
    }
    console.log('T04 actual legacy shell: stale edit, timer finish and import fenced after migration; refresh saves one timer record and preserves new history.');
  } else {
    console.log('T04 actual legacy shell skipped. Set ACADEMIC_LEGACY_DIST to the baseline build.');
  }

  for (const failUpdate of process.env.ACADEMIC_LEGACY_DIST ? [false, true] : []) {
    const ctx = await browser.newContext({ ...contextOptions, serviceWorkers: 'allow' });
    const s = await ctx.newPage();
    const a = await ctx.newPage();
    const later = mondayAt + 3600000;
    await at(s, later);
    await at(a, later);
    const old = legacy({ pause: true });
    await seed(s, old, 1);
    legacyShell = true;
    await s.goto(study);
    await s.waitForFunction(() => !!navigator.serviceWorker.controller);
    await s.locator('#study-content[aria-busy=false]').waitFor();
    const oldWorker = await readFile(dist.legacy + workerPath, 'utf8');
    const oldCache = 'hikari-study-shell-' + oldWorker.match(/const BUILD_VERSION = "([^"]+)"/)[1];
    assert.ok(await s.evaluate(key => caches.has(key), oldCache));
    await s.reload();
    await button(s, '记录').click();
    await alert(s, '#study-timer', '已暂停');
    const expected = await raw(s);

    legacyShell = false;
    blockWorkerUpdate = failUpdate;
    await a.goto(academic);
    if (failUpdate) {
      await readStatus(a, '学习工作台的离线版本尚未更新');
      assert.deepEqual(await raw(a), expected);
      await ctx.setOffline(true);
      await s.reload();
      await button(s, '记录').click();
      await alert(s, '#study-timer', '已暂停');
      assert.deepEqual(await raw(s), expected);

      blockWorkerUpdate = false;
      await ctx.setOffline(false);
      await button(a, '重试读取').click();
    }
    await a.getByRole('heading', { name: '开始使用' }).waitFor();
    const newWorker = await readFile(dist.current + workerPath, 'utf8');
    const newCache = 'hikari-study-shell-' + newWorker.match(/const BUILD_VERSION = "([^"]+)"/)[1];
    assert.notEqual(oldCache, newCache);
    assert.ok(await a.evaluate(key => caches.has(key), newCache));
    const migrated = await raw(a);
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.payload.data.sessions, old.sessions);
    assert.deepEqual(migrated.payload.data.timer, old.timer);

    // The still-loaded old shell must not be able to resume against schema 2.
    await button(s, '继续').click();
    await studyStatus(s, '操作未完成');
    assert.deepEqual(await raw(a), migrated);

    await ctx.setOffline(true);
    await s.reload();
    await button(s, '记录').click();
    await alert(s, '#study-timer', '已暂停');
    await s.locator('.study-list').filter({ hasText: 'synthetic record' }).first().waitFor();
    await button(s, '继续').click();
    await alert(s, '#study-timer', '进行中');
    await at(s, later + 120000);
    await button(s, '结束并保存').click();
    const finish = s.getByRole('dialog');
    assert.equal(await finish.getByLabel('实际时长').inputValue(), '3');
    await button(finish, '保存计时记录').click();
    await studyStatus(s, '学习记录已保存');
    await s.reload();
    await button(s, '记录').click();
    await button(s, '开始计时').waitFor();
    const saved = (await raw(s)).payload.data;
    assert.equal(saved.timer, null);
    assert.equal(saved.sessions.filter(item => item.id === old.timer.id).length, 1);
    assert.equal(saved.sessions.find(item => item.id === old.timer.id).minutes, 3);
    await ctx.close();
    console.log('Review P1: actual v1 worker, ' + (failUpdate ? 'failed update preserves old offline access; retry' : 'first Academic visit') +
      ' primes the new cache, fences the old tab, and permits one offline timer save.');
  }

  // Review P2: same UTF-8 v2 file restored and re-exported in both real UIs.
  {
    const dir = await mkdtemp(join(tmpdir(), 'academic-backup-'));
    try {
      const generated = largeBackupData();
      const file = exportBackupBlob(generated);
      const valid = join(dir, 'valid-utf8.json');
      const oversized = join(dir, 'too-large.json');
      await writeFile(valid, Buffer.from(await file.arrayBuffer()));
      await writeFile(oversized, '');
      await truncate(oversized, backupLimit + 1);
      for (const route of [study, academic]) {
        const ctx = await browser.newContext(contextOptions);
        const page = await ctx.newPage();
        await at(page, sunday);
        const { data } = sundayFixture();
        await seed(page, data);
        await page.goto(route);
        await openSettings(page);
        const before = await raw(page);
        const selector = route === study ? '#study-backup-file' : '[data-backup-file]';
        const status = route === study ? studyStatus : readStatus;
        await page.locator(selector).setInputFiles(oversized);
        await status(page, '备份超过 64 MiB');
        assert.deepEqual(await raw(page), before);
        await page.locator(selector).setInputFiles(valid);
        const dialog = page.getByRole('dialog');
        await dialog.getByText(/5600 条/).waitFor();
        await button(dialog, '确认覆盖并恢复').click();
        await status(page, '完整备份已恢复');
        if (route === academic) await openSettings(page);
        const download = page.waitForEvent('download');
        await button(page, route === study ? '导出 JSON' : '导出完整 JSON').click();
        const returned = JSON.parse(await readFile(await (await download).path(), 'utf8'));
        assert.equal(returned.version, 2);
        assert.deepEqual(returned.data, generated);
        await ctx.close();
      }
      console.log('Review P2: ' + file.size + ' bytes (5,600 records, 2,000 Han characters each) restored and re-exported in both UIs; 64 MiB + 1 rejected with unchanged DB.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Review P1: a January 11 UI edit cannot change an adjustment in January 4–10.
  {
    const ctx = await browser.newContext(contextOptions);
    const page = await ctx.newPage();
    const { data } = sundayFixture({ activates: false });
    data.plans[0].manual = [800, 100, 0];
    data.sessions[0].minutes = 110;
    data.sessions[1].minutes = 300;
    data.sessions[2].minutes = 150;
    await at(page, sunday);
    await seed(page, data);
    await page.goto(academic);
    await nav(page, '周报');
    await button(page, '以今天的数据结束本周预览').click();
    await button(page, '确认应用').click();
    await readStatus(page, '调整已确认');
    await at(page, wednesday);
    await page.reload();
    await page.locator('[data-academic-total]').waitFor();
    const before = (await raw(page)).payload.data.academic.adjustments[0];
    assert.equal(before.state, 'applied');
    assert.equal(before.appliedAt, mondayAt);
    assert.equal(before.endedAt, null);
    await at(page, instant('2027-01-11T18:00:00'));
    const closedWeek = async () => {
      await nav(page, '周报');
      const selection = form(page, 'review-week');
      await selection.getByLabel('查看日期所在周').fill('2027-01-04');
      await button(selection, '查看周报').click();
      return page.locator('.academic-table').innerText();
    };
    const history = await closedWeek();
    assert.match(history, /57%/);
    await nav(page, '课程');
    const course = page.locator('[data-keep="course-school-0"]');
    await course.locator(':scope > summary').click();
    await course.locator('[data-keep="params-school-0"] > summary').click();
    await course.getByLabel('个人成本').fill('2');
    await button(form(course, 'course'), '保存').click();
    await readStatus(page, '已保存');
    // Reload to force a separate shared read transaction after the cost write.
    await page.reload();
    await page.locator('[data-academic-total]').waitFor();
    const after = (await raw(page)).payload.data;
    assert.equal(after.academic.terms[0].courses[0].cost, 2);
    assert.deepEqual(after.academic.adjustments[0], before);
    assert.equal(await closedWeek(), history);
    await ctx.close();
    console.log('Review P1: January 11 cost form and subsequent read preserve the January 4–10 target table, state, timestamps and confirmation snapshot.');
  }

  // T12: no active page across the date change. Both the read and write entry paths use real IDB.
  for (const first of ['read', 'write', 'changed', 'race']) {
    const ctx = await browser.newContext(contextOptions);
    const a = await ctx.newPage();
    a.on('pageerror', error => console.error(error));
    const { data } = sundayFixture();
    await at(a, sunday);
    await seed(a, data);
    await a.goto(academic);
    await nav(a, '周报');
    await button(a, '以今天的数据结束本周预览').click();
    await button(a, '确认应用').click();
    await readStatus(a, '调整已确认');
    const stored = (await raw(a)).payload.data.academic.adjustments[0];
    assert.equal(stored.state, 'pending');
    const seen = await ctx.newPage();
    await at(seen, sunday);
    await seen.goto('/__academic-test');
    if (first === 'race') {
      const concurrency = await seen.evaluate(async ({ sunday, mondayAt }) => {
        const { openStudyRepository } = await import('/__source/study/storage.ts');
        const { recordDecision, propose } = await import('/__source/academic/review.ts');
        const one = await openStudyRepository();
        const two = await openStudyRepository();
        await one.update(state => { state.academic.adjustments = []; }, sunday);
        const snapshot = await one.read();
        const now = mondayAt + 15000;
        const proposal = propose(snapshot, snapshot.academic.terms[0], now);
        const attempts = await Promise.allSettled([one, two].map(repo => repo.update(state => recordDecision(state, proposal, now), now)));
        one.close();
        two.close();
        return attempts.map(entry => entry.status);
      }, { sunday, mondayAt });
      assert.deepEqual(concurrency, ['fulfilled', 'fulfilled']);
      assert.equal((await raw(seen)).payload.data.academic.adjustments.filter(item => item.appliedAt !== null).length, 1);
      await ctx.close();
      continue;
    }
    if (first === 'changed') {
      await at(seen, sunday + 1000);
      await seen.evaluate(async at => {
        const { openStudyRepository } = await import('/__source/study/storage.ts');
        const repo = await openStudyRepository();
        await repo.update(state => { state.academic.results[0].value++; }, at);
        repo.close();
      }, sunday + 1000);
    }
    await a.close();
    const readBack = await ctx.newPage();
    await at(readBack, wednesday);
    if (first === 'write' || first === 'read') {
      await readBack.goto('/__academic-test');
      await readBack.evaluate(async () => {
        const { openStudyRepository } = await import('/__source/study/storage.ts');
        window.academicTest = await openStudyRepository();
      });
      await ctx.setOffline(true);
      await readBack.evaluate(async ({ at, first }) => {
        if (first === 'read') await window.academicTest.read();
        else await window.academicTest.update(state => { state.academic.results = state.academic.results.slice(1); }, at);
        window.academicTest.close();
      }, { at: wednesday, first });
      await ctx.setOffline(false);
    }
    await readBack.goto(academic);
    await total(readBack, '0 分钟');
    const result = (await raw(readBack)).payload.data.academic.adjustments[0];
    if (first === 'changed') {
      assert.equal(result.state, 'invalid');
      assert.equal(result.appliedAt, null);
    } else {
      assert.equal(result.state, 'paused');
      assert.equal(result.appliedAt, mondayAt);
      assert.equal(result.endedAt, tuesdayAt);
      assert.deepEqual(result.proposal, stored.proposal);
    }
    await ctx.close();
  }
  console.log('T12 real IDB: Sunday confirmation, Monday application, Tuesday pause, Wednesday first offline read/write, pre-effect invalidation and concurrent Monday idempotence verified.');
} finally {
  await browser.close();
  server.close();
}
