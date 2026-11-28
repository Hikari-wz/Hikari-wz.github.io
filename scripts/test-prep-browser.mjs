import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { diff, materialize } from '../src/features/desk/entities.ts';
import { userA, userB } from './fixtures/desk-db.mjs';

const route = '/desk/academic/prep/';
const title = '合成备考任务';
const imported = '合成闭卷练习';
const secondTask = '合成回顾任务';
const slowTitle = '合成慢速勾选';
const retryTask = '合成503重试任务';
const retrySecondTask = '合成503第二任务';
const fileBytes = Buffer.from(`# 合成附件

测试正文。

## 题目速查

| 设问 | 来源 | 结构 | 关键词 |
| --- | :---: | --- | ---: |
| 第一题 | 讲义 | **因果** | 分析 \\| 回顾 |
| 第二题 | 附页 | ~~旧思路~~ | 复测 |

3. 第一项
   - 子要点
4. 第二项

- [x] 已检查
- [ ] 待检查

[不安全链接](javascript:alert%281%29)

![禁止外载](https://example.invalid/private.png)

<script>globalThis.prepUnsafe = true</script>

${'测试长文滚动。\n\n'.repeat(45)}
`);

async function addCourseAlias(database, subjectId, name) {
  const rows = await database.snapshot(userA);
  const state = materialize(rows);
  if (!state.academic.aliases.some(alias => alias.subjectId === subjectId && alias.name === name)) {
    state.academic.aliases.push({ subjectId, name });
    await database.commit(userA, randomUUID(), diff(rows, state));
  }
}

function markdownPlan(course, taskTitle, extraTitle = '') {
  return Buffer.from(`# 高等数学期末备考计划

| 字段 | 内容 |
| --- | --- |
| 科目 | ${course} |

## 第 1 周

- [ ] ${taskTitle}
${extraTitle ? `- [ ] ${extraTitle}\n` : ''}`);
}

export async function testPrepBrowser({ browser, devices, base, login, database, files, synthetic }) {
  const contexts = await Promise.all([
    browser.newContext({ ...devices['iPhone 13'], baseURL: base }),
    browser.newContext({ ...devices['iPad Mini'], baseURL: base }),
    browser.newContext({ viewport: { width: 1366, height: 900 }, baseURL: base }),
  ]);
  const errors = [];
  try {
    const [phone, tablet, desktop] = await Promise.all(contexts.map(context => context.newPage()));
    for (const page of [phone, tablet, desktop]) {
      await page.clock.setFixedTime(new Date('2026-11-28T02:00:00Z'));
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      page.setDefaultTimeout(12_000);
    }
    const button = (page, name) => page.getByRole('button', { name, exact: true });
    const link = (page, name) => page.getByRole('link', { name, exact: true });
    const synced = page => page.locator('[data-sync]').filter({ hasText: '已同步' }).waitFor();
    const row = (page, text) => page.getByRole('listitem').filter({ hasText: text });
    await login(phone, 'a@example.test', '/desk/academic/');
    await link(phone, '课程学习与备考中心').click();
    await link(phone, '高等数学').waitFor();
    await link(phone, '大学生心理健康').waitFor();
    assert.equal(new URL(phone.url()).pathname, route);
    await login(tablet, 'a@example.test', route);
    await login(desktop, 'b@example.test', route);

    await link(phone, '高等数学').click();
    await phone.locator('[data-prep-tab=routes]').waitFor();
    await button(phone, '资料').waitFor();

    const previewPlan = async plan => {
      await phone.locator('[data-import-file]').first().setInputFiles({
        name: '合成计划.md', mimeType: 'text/markdown', buffer: plan,
      });
      const dialog = phone.locator('dialog[open]').filter({ hasText: '确认 Markdown 导入' });
      await dialog.waitFor();
      return dialog;
    };
    let preview = await previewPlan(markdownPlan('大学英语（一）', '合成安全别名任务'));
    assert.equal(await preview.locator('select[name=destinationCourse]').inputValue(), 'school-1');
    await preview.getByText(/准备导入到“大学英语”/).waitFor();
    await button(preview, '取消').click();
    await preview.waitFor({ state: 'detached' });

    preview = await previewPlan(markdownPlan('不存在的合成课程', '合成未匹配任务'));
    await preview.getByText(/来源课程未匹配当前学期的课程/).waitFor();
    assert.equal(await preview.locator('select[name=destinationCourse]').inputValue(), '');
    assert.ok(await button(preview, '确认导入').isDisabled());
    await button(preview, '取消').click();
    await preview.waitFor({ state: 'detached' });

    await addCourseAlias(database, 'school-0', '大学英语（一）');
    await phone.reload();
    await synced(phone);
    preview = await previewPlan(markdownPlan('大学英语（一）', '合成歧义任务'));
    await preview.getByText(/来源课程匹配到多个目标/).waitFor();
    assert.equal(await preview.locator('select[name=destinationCourse]').inputValue(), '');
    assert.ok(await button(preview, '确认导入').isDisabled());
    await button(preview, '取消').click();
    await preview.waitFor({ state: 'detached' });
    console.log('Prep import alias stays unique; unmatched and ambiguous source courses require an explicit destination.');

    await phone.locator('button[data-action=task-add]').first().click();
    await phone.getByLabel('任务标题', { exact: true }).fill(title);
    await phone.locator('dialog[open] form button[type=submit]').click();
    await row(phone, title).waitFor();

    await phone.locator('button[data-action=task-add]').first().click();
    await phone.getByLabel('任务标题', { exact: true }).fill(slowTitle);
    await phone.locator('dialog[open] form button[type=submit]').click();
    await row(phone, slowTitle).waitFor();
    const slowBox = row(phone, slowTitle).getByRole('checkbox');
    const otherBox = row(phone, title).getByRole('checkbox');
    const protectsUnsavedToggle = () => phone.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return !window.dispatchEvent(event);
    });

    // While the server snapshot is delayed, no outbox row exists and the checkbox must stay unchanged.
    synthetic.snapshotDelayMs = 2_000;
    const preRead = phone.waitForRequest(request => request.url().endsWith('/desk_snapshot'));
    await slowBox.click();
    await preRead;
    await phone.locator('#prep-status').filter({ hasText: '正在保存任务到此设备' }).waitFor();
    assert.ok(await slowBox.isDisabled());
    assert.equal(await slowBox.isChecked(), false);
    assert.ok(await protectsUnsavedToggle());
    await phone.reload();
    await synced(phone);
    assert.equal(await slowBox.isChecked(), false);
    assert.equal(await protectsUnsavedToggle(), false);
    synthetic.snapshotDelayMs = 0;

    // Reproduce the empty-file import and current-week rerender during a delayed write.
    synthetic.commit.delayMs = 4_000;
    await slowBox.click();
    await phone.locator('#prep-status').filter({ hasText: '修改已暂存' }).waitFor();
    assert.ok(await slowBox.isChecked(), 'The new value becomes visible as soon as the local outbox is durable.');
    assert.equal(await protectsUnsavedToggle(), false);
    assert.ok(await slowBox.isDisabled());
    assert.ok(await phone.locator('[data-action=import-open]').isDisabled());
    await phone.locator('[data-import-file]').setInputFiles({
      name: '合成空计划.md', mimeType: 'text/markdown', buffer: Buffer.alloc(0),
    });
    await button(phone, '当前周').click();
    assert.ok(await slowBox.isDisabled());
    assert.ok(await otherBox.isDisabled());
    assert.match(await phone.locator('#prep-status').innerText(), /修改已暂存/);
    await otherBox.click({ force: true });
    await phone.reload();
    await synced(phone);
    assert.ok(await slowBox.isChecked());
    assert.equal(await otherBox.isChecked(), false);

    // An aborted import also restores the controls after the save has finished.
    await phone.locator('[data-import-file]').setInputFiles({
      name: '合成空计划.md', mimeType: 'text/markdown', buffer: Buffer.alloc(0),
    });
    await phone.locator('#prep-status').filter({ hasText: 'Markdown 内容为空' }).waitFor();
    assert.equal(await otherBox.isDisabled(), false);

    await slowBox.click();
    await phone.locator('#prep-status').filter({ hasText: '修改已暂存' }).waitFor();
    assert.ok(await slowBox.isDisabled());
    assert.equal(await slowBox.isChecked(), false);
    await phone.reload();
    await synced(phone);
    assert.equal(await slowBox.isChecked(), false);
    assert.equal(await slowBox.isDisabled(), false);
    synthetic.commit.delayMs = 0;
    console.log('Prep toggles preserve the prior value before IndexedDB, survive reload after acceptance, and stay locked across import/navigation.');

    await tablet.reload();
    await synced(tablet);
    await row(tablet, title).waitFor();
    await row(tablet, title).getByRole('checkbox').click();
    await tablet.locator('#prep-status').filter({ hasText: '任务已完成' }).waitFor();
    await phone.reload();
    await synced(phone);
    assert.ok(await row(phone, title).getByRole('checkbox').isChecked());

    await row(phone, title).locator('[data-action=task-edit]').click();
    await phone.getByLabel('任务标题', { exact: true }).fill(title + '（已编辑）');
    await phone.getByLabel(/所属周/).fill('2026-11-30');
    await phone.locator('dialog[open] form button[type=submit]').click();
    await tablet.reload();
    await synced(tablet);
    assert.equal(await row(tablet, title).count(), 0);
    await button(tablet, '下一周').click();
    await row(tablet, title).waitFor();
    await row(tablet, title).locator('[data-action=task-delete]').click();
    await row(tablet, title).waitFor({ state: 'detached' });
    await tablet.locator('[data-action=week-current]').click();

    const plan = Buffer.from('# 高等数学期末备考计划\n\n## 第 1 周\n\n- [ ] 必做｜合成闭卷练习\n- [ ] 选做｜合成回顾任务\n\n**闭卷验收**　独立作答。\n');
    const selectPlan = () => phone.locator('[data-import-file]').first().setInputFiles({
      name: '合成计划.md', mimeType: 'text/markdown', buffer: plan,
    });
    await phone.reload();
    await synced(phone);
    await selectPlan();
    await phone.locator('dialog[open]').getByText(/独立作答/).first().waitFor();
    for (const item of await phone.locator('dialog[open] [data-import-item]').all()) await item.check();
    await button(phone, '确认导入').click();
    await row(phone, imported).waitFor();
    await row(phone, secondTask).locator('[data-action=task-up]').click();
    await phone.locator('#prep-status').filter({ hasText: '任务顺序已更新' }).waitFor();
    const displayed = await phone.locator('[data-prep-week="2026-11-23"] [data-task-id]').allTextContents();
    const importedOrder = displayed.filter(text => text.includes(imported) || text.includes(secondTask));
    assert.match(importedOrder[0], /合成回顾任务/);
    await row(phone, imported).getByRole('checkbox').click();
    await phone.locator('#prep-status').filter({ hasText: '任务已完成' }).waitFor();
    await tablet.goto(route);
    await synced(tablet);
    assert.ok(await row(tablet, imported).getByRole('checkbox').isChecked());
    await selectPlan();
    await phone.locator('#prep-status').filter({ hasText: /跳过|已存在/ }).or(
      phone.locator('dialog[open]').getByText(/将跳过|已存在/).first(),
    ).first().waitFor();
    assert.equal(await row(phone, imported).getByRole('checkbox').count(), 1);
    assert.ok(await row(phone, imported).getByRole('checkbox').isChecked());

    await phone.keyboard.press('Escape');
    synthetic.commit.failures = 1;
    const retryPlan = markdownPlan('高等数学', retryTask, retrySecondTask);
    await phone.locator('[data-import-file]').first().setInputFiles({
      name: '合成503计划.md', mimeType: 'text/markdown', buffer: retryPlan,
    });
    const retryDialog = phone.locator('dialog[open]').filter({ hasText: '确认 Markdown 导入' });
    await retryDialog.locator('[data-import-item]').last().waitFor();
    for (const item of await retryDialog.locator('[data-import-item]').all()) await item.check();
    await button(retryDialog, '确认导入').click();
    await phone.locator('#prep-status').filter({ hasText: '待同步' }).waitFor();
    assert.doesNotMatch(await phone.locator('#prep-status').innerText(), /已导入/);
    assert.equal(synthetic.commit.failures, 0);
    assert.ok(!(await database.snapshot(userA)).some(row => row.kind === 'prepTasks' && row.payload?.title === retryTask));
    await phone.reload();
    await synced(phone);
    await row(phone, retryTask).waitFor();
    assert.ok((await database.snapshot(userA)).some(row => row.kind === 'prepTasks' && row.payload?.title === retryTask));
    assert.ok((await database.snapshot(userA)).some(row => row.kind === 'prepTasks' && row.payload?.title === retrySecondTask));
    console.log('A 503 import remains unconfirmed in 待同步 state, then succeeds after reload retry.');

    await button(phone, '资料').click();
    await phone.locator('[data-prep-input=upload]').setInputFiles({
      name: '合成资料.md', mimeType: 'text/markdown', buffer: fileBytes,
    });
    const material = phone.locator('li.prep-material').filter({ hasText: '合成资料.md' });
    await material.getByRole('button', { name: '阅读', exact: true }).waitFor();
    await material.getByRole('button', { name: '阅读', exact: true }).click();
    const reader = phone.getByRole('dialog', { name: '合成资料.md Markdown 阅读器' });
    await reader.getByRole('heading', { name: '合成附件', exact: true }).waitFor();
    const table = reader.getByRole('table');
    assert.equal(await table.getByRole('columnheader').count(), 4);
    assert.equal(await table.locator('tbody tr').count(), 2);
    assert.equal(await table.locator('strong').innerText(), '因果');
    assert.equal(await table.locator('del').innerText(), '旧思路');
    assert.equal(await table.getByRole('cell', { name: '分析 | 回顾' }).count(), 1);
    assert.equal(await table.getByRole('columnheader', { name: '来源' }).evaluate(cell => getComputedStyle(cell).textAlign), 'center');
    assert.equal(await reader.locator('ol[start="3"] > li > ul > li').innerText(), '子要点');
    assert.ok(await reader.getByRole('checkbox', { name: '已勾选' }).isChecked());
    assert.ok(await reader.getByRole('checkbox', { name: '未勾选' }).isDisabled());
    assert.equal(await reader.locator('a[href^="javascript:"], img, script').count(), 0);
    assert.equal(await phone.evaluate(() => globalThis.prepUnsafe), undefined);
    assert.equal(await phone.locator('.prep-materials__status').count(), 0);

    const scroller = reader.locator('.prep-markdown__table');
    assert.ok(await scroller.evaluate(el => el.scrollWidth > el.clientWidth));
    const body = reader.locator('[data-prep-reader-content]');
    assert.ok(await body.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollWidth <= el.clientWidth + 1));
    const header = reader.locator('.prep-materials__viewer-header');
    const headerTop = (await header.boundingBox()).y;
    await body.evaluate(el => { el.scrollTop = 800; });
    assert.ok(await body.evaluate(el => el.scrollTop > 0));
    assert.equal((await header.boundingBox()).y, headerTop);
    await phone.emulateMedia({ colorScheme: 'light' });
    const light = await reader.evaluate(el => getComputedStyle(el).backgroundColor);
    await phone.emulateMedia({ colorScheme: 'dark' });
    assert.notEqual(await reader.evaluate(el => getComputedStyle(el).backgroundColor), light);
    const mobileViewport = phone.viewportSize();
    await phone.setViewportSize({ width: 1366, height: 900 });
    assert.ok((await reader.boundingBox()).width > 850);
    assert.ok(await scroller.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await phone.setViewportSize(mobileViewport);
    await phone.emulateMedia({ colorScheme: null });
    await phone.keyboard.press('Escape');
    const download = phone.waitForEvent('download');
    await material.getByRole('button', { name: '下载', exact: true }).click();
    assert.deepEqual(await readFile(await (await download).path()), fileBytes);
    console.log('Markdown uses semantic tables and lists, keeps wide-table scrolling inside the reader, and respects light/dark themes.');

    const guardBytes = Buffer.from('# 删除保护\n\n仅用于验证元数据确认后的文件清理顺序。\n');
    await phone.locator('[data-prep-input=upload]').setInputFiles({
      name: '合成删除保护.md', mimeType: 'text/markdown', buffer: guardBytes,
    });
    let guarded = phone.locator('li.prep-material').filter({ hasText: '合成删除保护.md' });
    await guarded.getByRole('button', { name: '下载', exact: true }).waitFor();
    const filesBeforeGuard = files.size;
    const deletesBeforeGuard = synthetic.storage.requests.filter(request => request.method === 'DELETE').length;
    synthetic.commit.failures = 1;
    await guarded.getByRole('button', { name: '删除', exact: true }).click();
    await guarded.getByRole('button', { name: '继续删除', exact: true }).waitFor();
    assert.equal(
      synthetic.storage.requests.filter(request => request.method === 'DELETE').length,
      deletesBeforeGuard,
      'Storage must not be deleted until the removing metadata is cloud-confirmed.',
    );
    assert.equal(files.size, filesBeforeGuard);
    synthetic.storage.failures.delete = 1;
    await guarded.getByRole('button', { name: '继续删除', exact: true }).click();
    await phone.locator('.prep-materials__status').filter({ hasText: '删除云端文件失败' }).waitFor();
    assert.equal(files.size, filesBeforeGuard);
    await guarded.getByRole('button', { name: '继续删除', exact: true }).click();
    await guarded.waitFor({ state: 'detached' });
    assert.equal(files.size, filesBeforeGuard - 1);
    console.log('Prep file deletion waits for cloud metadata confirmation and resumes cleanly after failure.');

    await desktop.reload();
    await synced(desktop);
    assert.equal(await row(desktop, imported).count(), 0);
    assert.ok(!(await database.snapshot(userB)).some(entry => entry.kind === 'prepTasks' || entry.kind === 'prepMaterials'));
    assert.ok((await database.snapshot(userA)).some(entry => entry.kind === 'prepTasks' && !entry.deleted));
    assert.equal(files.size, 1);
    await material.getByRole('button', { name: '重命名', exact: true }).click();
    const rename = phone.locator('dialog[open]');
    await rename.getByLabel('名称', { exact: true }).fill('合成资料（重命名）');
    await rename.getByRole('button', { name: '保存', exact: true }).click();
    const renamed = phone.locator('li.prep-material').filter({ hasText: '合成资料（重命名）' });
    await renamed.waitFor();

    await tablet.goto('/desk/data/');
    await synced(tablet);
    const backupEvent = tablet.waitForEvent('download');
    await button(tablet, '导出完整云端备份').click();
    const backup = JSON.parse(await readFile(await (await backupEvent).path(), 'utf8'));
    assert.ok(backup.rows.some(item => item.kind === 'prepTasks' && item.payload?.done));
    assert.ok(backup.rows.some(item => item.kind === 'prepMaterials' && item.payload?.name === '合成资料（重命名）'));
    assert.ok(!JSON.stringify(backup).includes('globalThis.prepUnsafe'));

    const liveFile = backup.rows.find(item => item.kind === 'prepMaterials' && !item.deleted && item.payload?.kind === 'file');
    const withDeletion = backup.rows.map(item => item === liveFile
      ? { ...item, deleted: true, payload: null }
      : item);
    const restore = { ...backup, rows: withDeletion, sha256: createHash('sha256').update(JSON.stringify(withDeletion)).digest('hex') };
    await tablet.locator('[data-source]').setInputFiles({
      name: '合成附件墓碑.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(restore)),
    });
    const conflict = tablet.locator('[data-preview] details').filter({ hasText: '请保留云端资料' });
    await conflict.locator('summary').click();
    assert.deepEqual(await conflict.locator('option').evaluateAll(options => options.map(option => option.value)), ['', 'cloud']);
    await conflict.locator('select').selectOption('cloud');
    await button(tablet, '确认合并到云端').click();
    await tablet.locator('[data-message]').filter({ hasText: '云端确认' }).waitFor();
    assert.ok((await database.snapshot(userA)).some(item => item.kind === 'prepMaterials' && item.id === liveFile.id && !item.deleted));
    assert.equal(files.size, 1);

    // Simulate restoring metadata into an account whose object must be supplied separately.
    files.clear();
    await renamed.getByRole('button', { name: '阅读', exact: true }).click();
    await renamed.getByRole('button', { name: '补充缺失文件', exact: true }).waitFor();
    await renamed.getByRole('button', { name: '补充缺失文件', exact: true }).click();
    await phone.locator('[data-prep-input=restore]').setInputFiles({
      name: '合成资料.md', mimeType: 'text/markdown', buffer: fileBytes,
    });
    await phone.getByText('文件已补充到原资料。', { exact: true }).waitFor();
    assert.equal(files.size, 1);
    await renamed.getByRole('button', { name: '删除', exact: true }).click();
    await renamed.waitFor({ state: 'detached' });
    assert.equal(files.size, 0);

    await button(phone, '添加链接').click();
    const linkForm = phone.locator('dialog[open]');
    await linkForm.getByLabel('名称', { exact: true }).fill('合成学习链接');
    await linkForm.getByLabel(/外部链接/).fill('https://example.test/notes');
    await linkForm.getByRole('button', { name: '保存', exact: true }).click();
    const linkItem = phone.locator('li.prep-material').filter({ hasText: '合成学习链接' });
    assert.equal(await linkItem.getByRole('link', { name: '打开', exact: true }).getAttribute('href'), 'https://example.test/notes');

    const largeBytes = Buffer.alloc(24 * 1024 * 1024, 0x61);
    const largeName = '合成24MiB慢速文件.bin';
    synthetic.storage.delayMs.upload = 16_000;
    synthetic.storage.delayMs.download = 16_000;
    const uploadStarted = Date.now();
    await phone.locator('[data-prep-input=upload]').setInputFiles({
      name: largeName, mimeType: 'application/octet-stream', buffer: largeBytes,
    });
    const largeMaterial = phone.locator('li.prep-material').filter({ hasText: largeName });
    await phone.locator('.prep-materials__status').filter({ hasText: '已上传' }).waitFor({ timeout: 45_000 });
    assert.ok([...files.values()].some(file => file.bytes.length === largeBytes.length));
    assert.ok(Date.now() - uploadStarted >= 15_000, 'The synthetic upload must exceed the former 15 second transfer timeout.');
    const downloadStarted = Date.now();
    const largeDownload = phone.waitForEvent('download', { timeout: 45_000 });
    await largeMaterial.getByRole('button', { name: '下载', exact: true }).click();
    const savedLarge = await largeDownload;
    assert.ok(Date.now() - downloadStarted >= 15_000, 'The synthetic download must exceed the former 15 second transfer timeout.');
    const fileHash = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(fileHash(await readFile(await savedLarge.path())), fileHash(largeBytes));
    synthetic.storage.delayMs.upload = 0;
    synthetic.storage.delayMs.download = 0;
    await largeMaterial.getByRole('button', { name: '删除', exact: true }).click();
    await largeMaterial.waitFor({ state: 'detached' });
    console.log('24 MiB upload and download each survive a synthetic 16 second delay and preserve the bytes.');

    await tablet.goto(route);
    await synced(tablet);
    for (const page of [phone, tablet, desktop]) {
      for (const theme of ['light', 'dark']) {
        await page.getByLabel('主题偏好').selectOption(theme);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
    // Commit a remote edit after the local toggle is queued, before its delayed CAS.
    const remoteRows = await database.snapshot(userA);
    const remoteState = materialize(remoteRows);
    const remoteTask = remoteState.prepTasks.find(task => task.title === slowTitle);
    assert.equal(remoteTask.done, false);
    remoteTask.notes = '合成另一设备编辑';
    synthetic.commit.delayMs = 2_000;
    await row(tablet, slowTitle).getByRole('checkbox').click();
    await tablet.locator('[data-sync]').filter({ hasText: '待同步' }).waitFor();
    await database.commit(userA, randomUUID(), diff(remoteRows, remoteState));
    await tablet.locator('#prep-status').filter({ hasText: '同步存在冲突' }).waitFor();
    assert.doesNotMatch(await tablet.locator('#prep-status').innerText(), /任务已完成/);
    const remoteAfter = materialize(await database.snapshot(userA)).prepTasks.find(task => task.id === remoteTask.id);
    assert.deepEqual(remoteAfter, remoteTask);
    console.log('CAS conflict preserves the remote task and never reports the pending toggle as complete.');
    await row(tablet, imported).locator('[data-action=task-delete]').click();
    await tablet.locator('#prep-status').filter({ hasText: /操作未完成.*冲突/ }).waitFor();
    assert.ok((await database.snapshot(userA)).some(item => !item.deleted && item.payload?.title?.includes(imported)));
    console.log('With an existing conflict, a rejected deletion reports an error and preserves the task.');

    assert.deepEqual(errors, []);
    console.log('Prep cloud browser: shared tasks, safe import matching, slow saves, retryable failures, guarded materials and long transfers verified.');
  } finally {
    synthetic.snapshotDelayMs = 0;
    synthetic.commit.failures = 0;
    synthetic.commit.delayMs = 0;
    synthetic.storage.failures.delete = 0;
    synthetic.storage.delayMs.upload = 0;
    synthetic.storage.delayMs.download = 0;
    await Promise.all(contexts.map(context => context.close()));
  }
}
