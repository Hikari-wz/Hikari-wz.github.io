import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { userA, userB } from './fixtures/desk-db.mjs';

const route = '/desk/academic/prep/';
const title = '合成备考任务';
const imported = '合成闭卷练习';
const secondTask = '合成回顾任务';
const fileBytes = Buffer.from('# 合成附件\n\n测试正文。\n\n<script>globalThis.prepUnsafe = true</script>');

export async function testPrepBrowser({ browser, devices, base, login, database, files }) {
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
    await phone.locator('button[data-action=task-add]').first().click();
    await phone.getByLabel('任务标题', { exact: true }).fill(title);
    await phone.locator('dialog[open] form button[type=submit]').click();
    await row(phone, title).waitFor();
    await tablet.reload();
    await synced(tablet);
    await row(tablet, title).waitFor();
    await row(tablet, title).getByRole('checkbox').check();
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
    await button(phone, '确认导入').click();
    await row(phone, imported).waitFor();
    await row(phone, secondTask).locator('[data-action=task-up]').click();
    await phone.locator('#prep-status').filter({ hasText: '任务顺序已更新' }).waitFor();
    assert.match(await phone.locator('[data-prep-week="2026-11-23"] [data-task-id]').first().innerText(), /合成回顾任务/);
    await row(phone, imported).getByRole('checkbox').check();
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
    await button(phone, '资料').click();
    await phone.locator('[data-prep-input=upload]').setInputFiles({
      name: '合成资料.md', mimeType: 'text/markdown', buffer: fileBytes,
    });
    const material = phone.locator('li.prep-material').filter({ hasText: '合成资料.md' });
    await material.getByRole('button', { name: '阅读', exact: true }).waitFor();
    await material.getByRole('button', { name: '阅读', exact: true }).click();
    await phone.getByRole('heading', { name: '合成附件', exact: true }).waitFor();
    assert.equal(await phone.evaluate(() => globalThis.prepUnsafe), undefined);
    await phone.keyboard.press('Escape');
    const download = phone.waitForEvent('download');
    await material.getByRole('button', { name: '下载', exact: true }).click();
    assert.deepEqual(await readFile(await (await download).path()), fileBytes);

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

    await tablet.goto(route);
    await synced(tablet);
    for (const page of [phone, tablet, desktop]) {
      for (const theme of ['light', 'dark']) {
        await page.getByLabel('主题偏好').selectOption(theme);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
    assert.deepEqual(errors, []);
    console.log('Prep cloud browser: shared tasks, week navigation, import, private material viewing, restore, deletion and download on phone/tablet/desktop verified.');
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
}
