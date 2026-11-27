import type { DeskData } from '../academic/model.ts';
import { assertValid } from '../study/storage.ts';
import { canonical, equal, flatten, keyOf, materialize, type Entity } from './entities.ts';
export interface Conflict { key: string; cloud: unknown; source: unknown; reason: string }
export interface Preview {
  data: DeskData; tombstones: Entity[]; removed: number; added: number; duplicates: number; conflicts: Conflict[];
  before: { count: number; minutes: number }; after: { count: number; minutes: number };
}
export const totals = (data: DeskData) => ({ count: data.sessions.length, minutes: data.sessions.reduce((n, row) => n + row.minutes, 0) });
// Preview is recomputed in the committing transaction. It never writes or modifies a source.
export function mergePreview(cloud: DeskData, source: DeskData, deleted: Set<string> = new Set(), choices: Record<string, 'cloud' | 'source' | 'both'> = {}, sourceDeleted: Entity[] = []): Preview {
  assertValid(cloud); assertValid(source);
  const target = new Map(flatten(cloud).map(row => [keyOf(row), row]));
  const conflicts: Conflict[] = [];
  const sessionRemap = new Map<string, string>();
  let added = 0, duplicates = 0;
  const conflict = (key: string, row: Entity, old: Entity | undefined, reason: string) => {
    const choice = choices[key];
    if (choice === 'cloud') return;
    if (choice === 'source' && !deleted.has(key)) { target.set(key, row); return; }
    // Both only for independent study sessions. Stable suffix makes repeated merge idempotent.
    if (choice === 'both' && row.kind === 'sessions' && !deleted.has(key)) {
      const payload = structuredClone(row.payload) as { id: string };
      let hash = 14695981039346656037n;
      for (const char of canonical(payload)) hash = BigInt.asUintN(64, (hash ^ BigInt(char.charCodeAt(0))) * 1099511628211n);
      payload.id = row.id.slice(0, 72) + '_merge_' + hash.toString(16).padStart(16, '0');
      sessionRemap.set(row.id, payload.id);
      const copy = { ...row, id: payload.id, payload };
      const existing = target.get(keyOf(copy));
      if (existing && !equal(existing.payload, payload)) {
        conflicts.push({ key, cloud: existing.payload, source: row.payload, reason: '保留两条的标识发生碰撞，请分别备份后人工处理。' }); return;
      }
      if (!existing) { target.set(keyOf(copy), copy); added++; } else duplicates++;
      return;
    }
    conflicts.push({ key, cloud: old?.payload ?? null, source: row.payload, reason });
  };
  for (const row of flatten(source)) {
    if (row.kind === 'results') {
      const result = row.payload as DeskData['academic']['results'][number];
      result.sessionId = sessionRemap.get(result.sessionId) ?? result.sessionId;
    }
    const key = keyOf(row);
    const old = target.get(key);
    if (deleted.has(key)) { conflict(key, row, old, '该标识在云端已删除；保留云端删除，或在原始备份中确认后另建记录。'); continue; }
    if (old) {
      if (equal(old.payload, row.payload)) duplicates++;
      else if (row.kind === 'versions') {
        const left = old.payload as DeskData['academic']['versions'];
        const right = row.payload as typeof left;
        const clashes = right.some(v => left.some(w => v.at === w.at && !equal(v, w)));
        if (clashes && !choices[key]) conflict(key, row, old, '相同时间点的历史配置不同，请选择保留哪一来源；其他时间点将合并保留。');
        else {
          const preferSource = choices[key] === 'source';
          const preferred = preferSource ? right : left;
          const remaining = (preferSource ? left : right).filter(v => !preferred.some(w => w.at === v.at));
          const versions = [...preferred, ...remaining].sort((a,b) => a.at - b.at);
          target.set(key, { ...old, payload: versions });
        }
      }
      else conflict(key, row, old, '相同标识内容不同，请选择保留哪一份。');
    } else {
      // Identical content with different IDs is ambiguous, never automatically discarded.
      const signature = (value: unknown) => { const { id, ...rest } = value as Record<string, unknown>; return canonical(rest); };
      const uncertain = row.kind === 'sessions' && [...target.values()].find(item => item.kind === 'sessions' && signature(item.payload) === signature(row.payload));
      if (uncertain) {
        if (choices[key] === 'source' || choices[key] === 'both') { target.set(key, row); added++; }
        else if (choices[key] !== 'cloud') conflicts.push({ key, cloud: uncertain.payload, source: row.payload, reason: '不同标识的记录内容相同，可能是两次学习。请选择保留两条或跳过来源记录。' });
      } else { target.set(key, row); added++; }
    }
  }
  const tombstones: Entity[] = [];
  let removed = 0;
  for (const row of sourceDeleted) {
    const key = keyOf(row);
    if (deleted.has(key)) { duplicates++; continue; }
    const old = target.get(key);
    if (old && choices[key] !== 'source') {
      if (choices[key] !== 'cloud') conflicts.push({ key, cloud: old.payload, source: null, reason: '来源备份已删除此项，云端仍有记录。确认来源删除或保留云端。' });
      continue;
    }
    if (old) { target.delete(key); removed++; }
    tombstones.push({ ...row, payload: null, deleted: true });
  }
  let data = cloud;
  try { data = materialize([...target.values()]); }
  catch (error) { conflicts.push({ key: '@references', cloud: null, source: null, reason: '合并后关联无效，请调整冲突选择：' + (error instanceof Error ? error.message : '') }); }
  return { data, tombstones, removed, added, duplicates, conflicts, before: totals(cloud), after: totals(data) };
}
export async function legacyRaw(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('hikari-study-dashboard');
    request.onupgradeneeded = () => request.transaction!.abort();
    request.onerror = () => reject(new Error('当前浏览器没有可读取的旧数据。'));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('state', 'readonly');
      const read = tx.objectStore('state').getAll();
      const keys = tx.objectStore('state').getAllKeys();
      tx.oncomplete = () => { db.close(); resolve({ format: 'hikari-legacy-raw', version: 1,
        exportedAt: new Date().toISOString(), entries: keys.result.map((key, index) => ({ key, value: read.result[index] })) }); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
// Preserve all original values, but fence loaded v2 clients before allowing cloud writes.
export async function fenceLegacy() {
  const installed = await new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('hikari-study-dashboard');
    let missing = false;
    request.onupgradeneeded = () => { missing = true; request.transaction!.abort(); };
    request.onerror = () => missing ? resolve(0) : reject(request.error);
    request.onsuccess = () => { const version = request.result.version; request.result.close(); resolve(version); };
  });
  if (!installed || installed >= 3) return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('hikari-study-dashboard', 3);
    request.onupgradeneeded = () => { /* No store or record is altered. */ };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭旧版 Study / Academic 窗口后重新打开。旧数据尚未改变。'));
  });
}
