import { settle } from '../academic/review.ts';
import { cloudEnabled, client, owner } from './client.ts';
import { prepareDesk } from './ui.ts';
import { legacyRaw, mergePreview, type Preview } from './migration.ts';
import { importBackup, backupLimit } from '../study/storage.ts';
import { materialize, keyOf, type Entity } from './entities.ts';
import { openCloudRepository, discardPending, pendingBackup, projected } from './repository.ts';
import type { DeskData } from '../academic/model.ts';

const root = document.querySelector<HTMLElement>('#desk-data')!;
const content = root.querySelector<HTMLElement>('[data-content]')!;
const message = root.querySelector<HTMLElement>('[data-message]')!;
function download(value: unknown, label: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url;
  link.download = 'hikari-' + label + '-' + new Date().toISOString().slice(0, 10) + '.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
async function digest(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
root.querySelector('[data-raw]')!.addEventListener('click', async () => {
  try { download(await legacyRaw(), 'legacy-raw'); root.querySelector('[data-raw-status]')!.textContent = '原始备份已生成，请确认文件已保存。'; }
  catch (error) { root.querySelector('[data-raw-status]')!.textContent = String(error); }
});
if (!cloudEnabled) {
  content.textContent = '当前构建未启用云端模式。原有业务数据仍在原浏览器保存；原始导出入口可用。';
} else {
  try {
    await prepareDesk(root, content);
    const repository = await openCloudRepository();
    let source: DeskData | undefined;
    let sourceDeleted: Entity[] = [];
    let cloud: DeskData;
    let deleted = new Set<string>();
    let choices: Record<string, 'cloud' | 'source' | 'both'> = {};
    let preview: Preview;
    const area = root.querySelector<HTMLElement>('[data-preview]')!;
    async function fresh() {
      const cache = await pendingBackup();
      if (cache.pending.length) throw new Error('请先同步或处理当前待同步操作，再预览迁移。');
      const { data, error } = await client().rpc('desk_snapshot');
      if (error) throw error;
      const rows = data as Entity[];
      cloud = materialize(rows);
      settle(cloud, Date.now());
      deleted = new Set(rows.filter(row => row.deleted).map(keyOf));
    }
    function renderPreview() {
      preview = mergePreview(cloud, source!, deleted, choices, sourceDeleted);
      area.replaceChildren();
      const summary = document.createElement('p');
      summary.textContent = `新增 ${preview.added} 项，确认删除 ${preview.removed} 项，重复 ${preview.duplicates} 项，未解决冲突 ${preview.conflicts.length} 项，无法识别 0 项。学习记录 ${preview.before.count} → ${preview.after.count} 条，时长 ${preview.before.minutes} → ${preview.after.minutes} 分钟。`;
      area.append(summary);
      if (Object.keys(choices).length) {
        const reset = document.createElement('button'); reset.className = 'study-action'; reset.textContent = '重置冲突选择';
        reset.addEventListener('click', () => { choices = {}; renderPreview(); }); area.append(reset);
      }
      for (const conflict of preview.conflicts) {
        const detail = document.createElement('details');
        const title = document.createElement('summary'); title.textContent = conflict.key + '：' + conflict.reason;
        detail.append(title);
        const values = document.createElement('pre'); values.style.whiteSpace = 'pre-wrap'; values.style.overflowWrap = 'anywhere';
        values.textContent = JSON.stringify({ 云端: conflict.cloud, 来源: conflict.source }, null, 2); detail.append(values);
        if (conflict.key !== '@references') {
          const select = document.createElement('select'); select.setAttribute('aria-label', conflict.key + ' 冲突选择');
          const options = [['', '请选择'], ['cloud', '保留云端 / 跳过来源']];
          if (!conflict.keepCloudOnly && !deleted.has(conflict.key)) options.push(['source', '使用来源值']);
          if (conflict.key.startsWith('sessions/') && conflict.source !== null && !deleted.has(conflict.key)) options.push(['both', '保留两条学习记录']);
          for (const [value, text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
          select.addEventListener('change', () => { choices[conflict.key] = select.value as 'cloud' | 'source' | 'both'; renderPreview(); });
          detail.append(select);
        }
        area.append(detail);
      }
      const confirm = document.createElement('button'); confirm.className = 'study-action primary'; confirm.textContent = '确认合并到云端';
      confirm.disabled = !!preview.conflicts.length;
      confirm.addEventListener('click', () => void run(async () => {
        const expected = structuredClone(cloud);
        const approved = structuredClone(preview.data);
        await repository.merge(expected, approved, preview.tombstones);
        const cache = await pendingBackup();
        if (cache.pending.length) throw new Error('合并已保存在待同步队列，尚未确认云端成功。可在网络恢复后重试。');
        const result = await repository.read();
        message.textContent = `云端确认：${result.sessions.length} 条学习记录，共 ${result.sessions.reduce((n, row) => n + row.minutes, 0)} 分钟。请核对各来源并保留原始备份。`;
        source = undefined; area.replaceChildren();
      }));
      area.append(confirm);
    }
    async function run(action: () => Promise<void>) {
      const controls = [...content.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')];
      const previous = controls.map(control => control.disabled);
      controls.forEach(control => { control.disabled = true; });
      try { await action(); } catch (error) { message.textContent = error instanceof Error ? error.message : String(error); }
      finally { controls.forEach((control, index) => { control.disabled = previous[index]; }); }
    }
    root.querySelector<HTMLInputElement>('[data-source]')!.addEventListener('change', event => void run(async () => {
      source = undefined; sourceDeleted = []; area.replaceChildren();
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0]; input.value = ''; if (!file) return;
      if (file.size > backupLimit) throw new Error('文件超过 64 MiB。');
      const text = await file.text(); const parsed = JSON.parse(text);
      if (parsed.format === 'hikari-legacy-raw') {
        const entry = parsed.entries?.find((item: { key: string }) => item.key === 'current');
        if (!entry) throw new Error('原始备份缺少 current 记录；请保留文件以便人工恢复。');
        source = importBackup(JSON.stringify({ ...entry.value, exportedAt: parsed.exportedAt }));
      } else if (parsed.format === 'hikari-desk-cloud' && parsed.version === 1 && parsed.schema === 1) {
        if (await digest(parsed.rows) !== parsed.sha256) throw new Error('云端备份校验和不一致。');
        source = materialize(parsed.rows);
        sourceDeleted = (parsed.rows as Entity[]).filter(row => row.deleted);
      } else if (parsed.format === 'hikari-desk-outbox' && parsed.version === 1) {
        // Queue backup contains optimistic local values, never writes queued RPCs directly.
        const rows = projected(parsed.cache);
        source = materialize(rows); sourceDeleted = rows.filter(row => row.deleted);
      } else source = importBackup(text);
      await repository.read(); await fresh(); choices = {}; renderPreview();
      message.textContent = '已验证来源格式和关联。请核对预览后确认。';
    }));
    root.querySelector('[data-cloud-export]')!.addEventListener('click', () => void run(async () => {
      await owner(); const { data, error } = await client().rpc('desk_snapshot'); if (error) throw error;
      materialize(data as Entity[]);
      download({ format: 'hikari-desk-cloud', version: 1, schema: 1, exportedAt: new Date().toISOString(),
        rows: data, sha256: await digest(data) }, 'cloud-backup');
      message.textContent = '完整云端备份已生成（含备考任务、资料元数据和删除墓碑）。资料文件本体请在备考资料视图逐项下载归档；待同步修改请另行导出队列。';
    }));
    const outbox = async () => {
      const cache = await pendingBackup();
      download({ format: 'hikari-desk-outbox', version: 1, exportedAt: new Date().toISOString(), cache }, 'outbox');
    };
    root.querySelector('[data-outbox]')!.addEventListener('click', () => void run(outbox));
    root.querySelector('[data-discard]')!.addEventListener('click', () => void run(async () => {
      await outbox();
      if (!confirm('请确认刚生成的队列备份已保存。放弃本设备待同步修改并重新读取云端？')) return;
      await discardPending(); await repository.read(); source = undefined; area.replaceChildren();
      message.textContent = '已重新读取云端。可选择刚导出的队列文件，预览并合并需要保留的内容。';
    }));
    root.querySelector('[data-retry]')!.addEventListener('click', () => void run(async () => { await repository.read(); }));
    await repository.read();
  } catch (error) { message.textContent = String(error); }
}
