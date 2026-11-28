import type { DeskData } from '../academic/model.ts';
import { settle, reconcileUpdate } from '../academic/review.ts';
import { assertValid, reconcileReferences, type StudyRepository } from '../study/storage.ts';
import { apply, diff, materialize, equal, keyOf, type Entity } from './entities.ts';
import { cacheRead, cacheWrite, exclusive, type Cache } from './cache.ts';
import { client, owner } from './client.ts';
import { fileMergeBlocked, fileMergeMessage } from './migration.ts';

export type SyncState = 'synced' | 'pending' | 'offline' | 'failed' | 'conflict';
export function syncStatus(state: SyncState, count = 0, detail = '') {
  window.dispatchEvent(new CustomEvent('desk-sync', { detail: { state, count, detail } }));
}
function announce() {
  const channel = new BroadcastChannel('hikari-study-dashboard');
  channel.postMessage('changed'); channel.close();
}
function snapshot(input: unknown): Entity[] {
  if (!Array.isArray(input)) throw new Error('云端响应格式异常。');
  const rows = input as Entity[];
  if (rows.some(row => !row || typeof row.kind !== 'string' || typeof row.id !== 'string' ||
    !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.deleted !== 'boolean')) throw new Error('云端版本信息异常。');
  materialize(rows);
  return rows;
}
async function synchronize(user: string, cache: Cache) {
  if (cache.conflict) { syncStatus('conflict', cache.pending.length, cache.conflict); return; }
  try {
    while (cache.pending.length) {
      const pending = cache.pending[0];
      const { data, error } = await client().rpc('desk_commit', { operation_id: pending.id, changes: pending.changes });
      if (error) {
        if (error.code === '40001' || error.code?.startsWith('23') || error.code === '22023') {
          cache.conflict = error.message;
          await cacheWrite(user, cache);
          syncStatus('conflict', cache.pending.length, error.message);
          return;
        }
        throw error;
      }
      // Persist acknowledgement before advancing to the next queued operation.
      const next = { ...cache, rows: snapshot(data), pending: cache.pending.slice(1), initialized: true };
      await cacheWrite(user, next);
      Object.assign(cache, next);
    }
    const { data, error } = await client().rpc('desk_snapshot');
    if (error) throw error;
    cache.rows = snapshot(data);
    cache.initialized = true;
    await cacheWrite(user, cache);
    syncStatus('synced');
  } catch (error) {
    syncStatus(navigator.onLine ? 'failed' : 'offline', cache.pending.length,
      error && typeof error === 'object' && 'message' in error ? String(error.message) : '连接中断，已保存的待同步操作将重试。');
    if (!cache.initialized) throw new Error('首次使用必须联网成功读取云端数据。读取失败未被视为空数据库。');
  }
}
export function projected(cache: Cache): Entity[] {
  return cache.pending.reduce((rows, operation) => apply(rows, operation.changes), cache.rows);
}
export type WriteOutcome = 'confirmed' | 'pending' | 'conflict';
export function pendingWriteMessage(outcome: Exclude<WriteOutcome, 'confirmed'>) {
  return outcome === 'conflict'
    ? '修改已暂存于此设备，但同步存在冲突。请前往数据中心处理。'
    : '修改已暂存于此设备，待同步。请查看同步状态。';
}
type Update = Parameters<StudyRepository['update']>[0];
type WriteResult = { data: DeskData; outcome: WriteOutcome };
type CloudRepository = StudyRepository & {
  updateWithOutcome(change: Update): Promise<WriteResult>;
  merge(expected: DeskData, approved: DeskData, tombstones: Entity[]): Promise<DeskData>;
};
export async function openCloudRepository(): Promise<CloudRepository> {
  const user = await owner();
  let closed = false;
  async function check() {
    if (closed || await owner() !== user) throw new Error('登录状态已改变，请重新打开页面。');
  }
  async function read() {
    return exclusive(user, async () => {
      await check();
      const cache = await cacheRead(user);
      await synchronize(user, cache);
      await check();
      const data = materialize(projected(cache));
      settle(data, Date.now());
      return data;
    });
  }
  const mutate = (change: Update, at?: number, tombstones: Entity[] = []) => exclusive<WriteResult>(user, async () => {
      await check();
      const cache = await cacheRead(user);
      await synchronize(user, cache);
      await check();
      if (cache.conflict) throw new Error('待同步操作存在冲突，请先在数据中心处理。');
      const rows = projected(cache);
      const data = materialize(rows);
      const now = at ?? Date.now();
      settle(data, now);
      const before = structuredClone(data);
      change(data);
      reconcileReferences(before, data);
      reconcileUpdate(before, data, now);
      assertValid(data);
      const changes = diff(rows, data);
      for (const tombstone of tombstones) {
        const old = rows.find(row => keyOf(row) === keyOf(tombstone));
        if (old?.deleted || changes.some(row => keyOf(row) === keyOf(tombstone))) continue;
        if (old) throw new Error('来源删除尚未在预览中确认。');
        changes.push({ kind: tombstone.kind, id: tombstone.id, ordinal: tombstone.ordinal, payload: null, expected: null, deleted: true });
      }
      const operationId = changes.length ? crypto.randomUUID() : undefined;
      if (operationId) {
        cache.pending.push({ id: operationId, changes });
        await cacheWrite(user, cache); // No successful acceptance before IndexedDB commits.
        syncStatus('pending', cache.pending.length);
        announce();
        await synchronize(user, cache);
      }
      await check();
      const pending = operationId ? cache.pending.some(operation => operation.id === operationId) : cache.pending.length > 0;
      const outcome = pending ? (cache.conflict ? 'conflict' : 'pending') : 'confirmed';
      return { data: materialize(projected(cache)), outcome };
    });
  return {
    read,
    update: async (change, at) => (await mutate(change, at)).data,
    updateWithOutcome: (change) => mutate(change),
    merge: async (expected, approved, tombstones) => (await mutate(state => {
      if (!equal(state, expected)) throw new Error('云端或学业状态已改变，请重新选择文件并预览。');
      const approvedMaterials = new Map((approved.prepMaterials ?? []).map(item => [item.id, item]));
      const removed = new Set(tombstones.filter(row => row.kind === 'prepMaterials').map(row => row.id));
      if (state.prepMaterials?.some(item => fileMergeBlocked(item,
        removed.has(item.id) ? undefined : approvedMaterials.get(item.id)))) throw new Error(fileMergeMessage);
      Object.assign(state, structuredClone(approved));
    }, undefined, tombstones)).data,
    restore: async () => { throw new Error('云端模式禁止整库覆盖。请打开数据中心，预览并合并备份。'); },
    close: () => { closed = true; },
  };
}
export async function discardPending() {
  const user = await owner();
  await exclusive(user, async () => {
    const cache = await cacheRead(user);
    cache.pending = []; delete cache.conflict;
    await cacheWrite(user, cache);
  });
  announce();
}
export async function pendingBackup() {
  const user = await owner();
  return exclusive(user, () => cacheRead(user));
}
