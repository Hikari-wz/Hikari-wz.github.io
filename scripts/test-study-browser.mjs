import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from 'playwright-core';

const route = '/desk/study/';
const workerPath = route + 'sw.js';
const worker = await readFile('dist' + workerPath, 'utf8');
let workerResponse = worker;
let missingShellRequested = false;
const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png' };
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/missing-study-shell.js') missingShellRequested = true;
  const file = path.endsWith('/') ? path + 'index.html' : path;
  try {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', mime[file.split('.').pop()] ?? 'application/octet-stream');
    response.end(path === workerPath ? workerResponse : await readFile(join('dist', file)));
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseURL = 'http://127.0.0.1:' + server.address().port;
async function waitUntil(test, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await test()) return;
    await delay(50);
  }
  assert.fail(message);
}

let browser;
try {
  browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : { channel: 'chrome' });
  const context = await browser.newContext({ ...devices['iPhone 13'], baseURL, reducedMotion: 'reduce', colorScheme: 'light' });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const at = instant => page.clock.setFixedTime(new Date(instant));
  const nav = page.getByRole('navigation', { name: '学习工作台导航' });
  const open = name => nav.getByRole('button', { name, exact: true }).click();
  const button = (name, region = page) => region.getByRole('button', { name, exact: true });
  const form = name => page.locator('form[data-form="' + name + '"]');
  const text = async (selector, expected) => {
    await page.locator(selector).filter({ hasText: expected }).first().waitFor();
  };
  const status = expected => text('#study-status', expected);
  const total = expected => text('.study-total', expected);
  const expectNoOverflow = async name => assert.ok(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'Horizontal overflow on ' + name);

  await at('2026-11-23T05:00:00Z');
  await page.goto(route);
  await total('0 分钟');
  await text('#study-content', '本周还没有计划');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const manifestLink = await page.locator('link[rel=manifest]').getAttribute('href');
  const manifest = await (await page.request.get(manifestLink)).json();
  assert.equal(manifest.scope, route);
  assert.equal(manifest.start_url, route);
  assert.equal(manifest.display, 'standalone');
  for (const icon of [...manifest.icons, { src: 'icon-180.png', sizes: '180x180' }]) {
    const binary = await (await page.request.get(route + icon.src)).body();
    assert.equal(binary.readUInt32BE(16) + 'x' + binary.readUInt32BE(20), icon.sizes);
  }
  await expectNoOverflow('iPhone overview');
  console.log('Manifest, icons, service worker and iPhone overview verified.');
  const bounds = await nav.boundingBox();
  assert.ok(bounds.y + bounds.height <= 845, 'fixed bottom nav');
  await open('计划');
  const weekly = form('plan');
  for (const [index, minutes] of [240, 60, 240, 180, 240, 360, 360].entries()) {
    await weekly.locator('[name=d' + index + ']').fill(String(minutes));
  }
  await text('#study-budget-preview', '机动 2 小时 48 分');
  await text('#study-budget-preview', '8 小时 49 分');
  await button('保存周计划').click();
  await status('快照已保存');
  await expectNoOverflow('iPhone plan');
  await button('下周').click();
  await button('复制上周可用时间').click();
  assert.equal(await weekly.locator('[name=d1]').inputValue(), '60');
  await button('上周').click();

  await page.locator('#study-exam-editor summary').click();
  const exam = form('exam');
  await exam.getByLabel('考试名称').fill('高数期末');
  await exam.getByLabel('对应科目').selectOption('school-0');
  await exam.getByLabel('考试日期').fill('2026-11-25');
  await exam.getByLabel('开始时间').fill('09:00');
  await exam.getByLabel('结束时间').fill('14:00');
  await button('添加考试', exam).click();
  await status('考试已保存');
  await open('概览');
  await total('考前冲刺期');
  await text('#study-content', '还有 2 天');
  await at('2026-11-25T05:59:00Z');
  await page.reload();
  await total('考前冲刺期');
  await at('2026-11-25T06:00:00Z');
  await total('常规学习期');
  await button('考试与任务').click();
  await page.locator('details[data-keep=ended-exams] summary').click();
  await text('details[data-keep=ended-exams]', '高数期末');
  console.log('Weekly allocation, copy and automatic exam-stage transition verified.');

  await open('概览');
  await button('快速补录').click();
  const quick = form('session');
  await quick.getByLabel('学习类别').selectOption('self');
  await quick.getByLabel('科目或项目').selectOption('self-0');
  await button('45 分', quick).click();
  await quick.locator('summary').click();
  await quick.getByLabel('质量或进展').selectOption('能够独立应用');
  await button('保存学习记录', quick).click();
  await status('学习记录已保存');
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('hikari-study-dashboard', 2);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('state', 'readwrite');
      const store = tx.objectStore('state');
      const current = store.get('current');
      current.onsuccess = () => {
        current.result.data.sessions[0].note = '独立完成 STL 练习 <b>原样显示</b>';
        store.put(current.result, 'current');
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
    request.onerror = () => reject(request.error);
  }));
  await page.reload();
  await open('概览');
  await total('45 分钟');
  await open('记录');
  await expectNoOverflow('iPhone records');
  assert.equal(await page.locator('.study-list p b').count(), 0, 'escaped data');
  await button('编辑', page.locator('.study-list li').filter({ hasText: '独立完成 STL 练习' }).first()).click();
  await quick.getByLabel('实际时长').fill('120');
  await button('保存修改', quick).click();
  await status('学习记录已保存');
  await open('概览');
  await total('2 小时');

  await button('设置').click();
  const self = page.locator('details[data-keep=subjects-self]');
  await self.locator('summary').click();
  const cpp = self.locator('form[data-form=subject][data-value=self-0]');
  await cpp.getByLabel('名称').fill('C++ 基础');
  await button('保存名称', cpp).click();
  await status('名称已更新');
  await button('归档', cpp).click();
  await status('科目与项目设置已更新');
  await open('记录');
  await text('.study-list li', 'C++ 基础 已归档');
  const timer = form('timer');
  await timer.getByLabel('学习类别').selectOption('self');
  assert.equal(await timer.locator('[name=subjectId] option[value=self-0]').count(), 0);
  await timer.getByLabel('学习类别').selectOption('project');
  await timer.getByLabel('科目或项目').selectOption('project-0');
  await button('开始计时', timer).click();
  await status('计时已开始');
  const otherWindow = await context.newPage();
  await otherWindow.goto(route);
  await otherWindow.getByRole('navigation', { name: '学习工作台导航' }).getByRole('button', { name: '记录' }).click();
  await otherWindow.getByRole('button', { name: '暂停', exact: true }).waitFor();
  assert.equal(await otherWindow.locator('form[data-form=timer]').count(), 0);
  await otherWindow.close();
  await at('2026-11-25T06:15:00Z');
  await page.reload();
  await open('记录');
  await text('#study-timer-clock', '00:15:00');
  await button('暂停').click();
  await status('计时状态已保存');
  await at('2026-11-25T10:15:00Z');
  await text('#study-timer-clock', '00:15:00');
  await button('继续').click();
  await status('计时状态已保存');
  await at('2026-11-25T15:15:00Z');
  await text('#study-timer-clock', '05:15:00');
  await text('#study-timer-long', '计时已达 4 小时');
  await button('结束并保存').click();
  const finish = form('finish-timer');
  await finish.getByLabel('实际时长').fill('20');
  await button('保存计时记录', finish).click();
  await status('学习记录已保存');
  await text('.study-list li', '20 分钟');
  console.log('Quick entry, archive and timestamp-based timer verified.');

  await at('2026-11-29T07:00:00Z');
  await open('概览');
  await button('开始本周复盘').click();
  const review = form('review');
  await review.getByLabel('能够独立应用的知识').fill('STL');
  await review.getByLabel('下周重点学习目标').fill('继续学习容器');
  await button('保存复盘').click();
  await status('复盘已保存');
  await button('建立下周计划').click();
  await weekly.getByText('继续学习容器', { exact: true }).waitFor();
  await weekly.locator('summary').click();
  await weekly.getByLabel('使用自定目标').check();
  await weekly.locator('[name=t0]').fill('500');
  await weekly.locator('[name=t1]').fill('800');
  await weekly.locator('[name=t2]').fill('212');
  await button('保存周计划').click();
  await status('快照已保存');

  await button('设置').click();
  const settings = form('settings');
  await settings.getByLabel('阶段判定').selectOption('sprint');
  await button('保存设置').click();
  await status('设置已保存');
  await open('概览');
  await total('考前冲刺期');
  await text('#study-content', '手动覆盖');
  await button('设置').click();

  const download = page.waitForEvent('download');
  await button('导出 JSON').click();
  const json = await readFile(await (await download).path(), 'utf8');
  const backup = JSON.parse(json);
  assert.equal(backup.data.sessions.length, 2);
  assert.ok(backup.data.sessions.some(row => row.note === '独立完成 STL 练习 <b>原样显示</b>'));
  assert.equal(backup.data.reviews[0].knowledge, 'STL');
  assert.deepEqual(backup.data.plans.find(plan => plan.manual).manual, [500, 800, 212]);
  assert.equal(backup.data.timer, null);
  await open('记录');
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: '历史记录' }) });
  await form('filter').locator('[name=track]').selectOption('project');
  await text('.study-list li', '20 分钟');
  page.once('dialog', confirm => confirm.accept());
  await history.getByRole('button', { name: '删除', exact: true }).click();
  await status('学习记录已删除');
  await open('概览');
  await total('2 小时');

  await button('设置').click();
  const file = page.locator('#study-backup-file');
  await file.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await status('无法读取 JSON');
  await file.setInputFiles({ name: 'study.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  const dialog = page.getByRole('dialog', { name: '恢复本地备份' });
  await dialog.waitFor();
  const preservation = page.waitForEvent('download');
  await button('先导出当前数据', dialog).click();
  assert.equal(JSON.parse(await readFile(await (await preservation).path(), 'utf8')).data.sessions.length, 1);
  await button('确认覆盖并恢复', dialog).click();
  await status('完整备份已恢复');
  await expectNoOverflow('iPhone settings');
  await open('制度');
  await text('#study-content', 'AI 辅助学习原则');
  await expectNoOverflow('iPhone policy');
  console.log('Review, next-week plan, record filtering and backup recovery verified.');

  await context.setOffline(true);
  await page.reload();
  await total('2 小时 20 分');
  await button('快速补录').click();
  await quick.getByLabel('科目或项目').selectOption('school-0');
  await button('保存学习记录', quick).click();
  await status('学习记录已保存');
  await open('概览');
  await total('2 小时 50 分');
  await context.setOffline(false);

  const versionName = async () => page.evaluate(async () => (await caches.keys()).find(key => key.startsWith('hikari-study-shell-')));
  const firstCache = await versionName();
  workerResponse = worker.replace(/const BUILD_VERSION = "[^"]+";/, 'const BUILD_VERSION = "test-failed";')
    .replace('const SHELL_PATHS = [', 'const SHELL_PATHS = ["/missing-study-shell.js",');
  console.log('Offline reload and writing an offline record verified.');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await waitUntil(() => missingShellRequested, 'the failing worker should attempt to cache a missing file');
  await waitUntil(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const cacheNames = await caches.keys();
    return !registration.installing && !cacheNames.includes('hikari-study-shell-test-failed');
  }), 'the failed worker should remove its incomplete cache');
  assert.equal(await versionName(), firstCache, 'failed installation retained the prior shell');
  workerResponse = worker.replace(/const BUILD_VERSION = "[^"]+";/, 'const BUILD_VERSION = "test-updated";');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await button('刷新使用新版').waitFor();
  await waitUntil(() => page.evaluate(async oldCache => {
    const names = await caches.keys();
    return names.includes('hikari-study-shell-test-updated') && !names.includes(oldCache);
  }, firstCache), 'a successful update should replace the old cache');
  assert.equal(await versionName(), 'hikari-study-shell-test-updated');
  await button('刷新使用新版').click();
  await total('2 小时 50 分');

  await at('2026-12-07T02:00:00Z');
  await open('计划');
  await button('保存周计划').click();
  await status('快照已保存');
  await open('概览');
  await text('#study-content', '零预算');
  await button('快速补录').click();
  await quick.getByLabel('科目或项目').selectOption('school-0');
  await button('保存学习记录', quick).click();
  await status('学习记录已保存');
  await open('概览');
  await text('#study-content', '零预算 · 超出 30 分钟');
  await open('计划');
  await page.locator('#study-week-picker').selectOption('2026-11-23');
  await text('#study-content', '8 小时 49 分');
  assert.equal(await button('更新周计划').count(), 0, 'historical budget is read-only');
  assert.doesNotMatch(await page.locator('#study-content').textContent(), /NaN|Infinity/);

  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      for (const view of ['计划', '记录', '制度', '概览']) {
        await open(view);
        await expectNoOverflow(width + '/' + colorScheme + '/' + view);
      }
    }
  }
  const desk = await context.newPage();
  await desk.goto('/desk/');
  assert.equal(await desk.getByRole('link', { name: '打开学习工作台' }).getAttribute('href'), route);
  assert.equal(await desk.evaluate(() => !!navigator.serviceWorker.controller), false);
  assert.deepEqual(errors, []);
  console.log('Verified Study Dashboard CRUD, snapshots, review, timestamp timer, backup recovery, layout, offline and worker updates.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
