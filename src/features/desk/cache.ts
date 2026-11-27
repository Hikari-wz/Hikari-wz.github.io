import type { Change, Entity } from './entities.ts';
export interface Pending { id: string; changes: Change[] }
export interface Cache { rows: Entity[]; pending: Pending[]; initialized: boolean; conflict?: string }
export const blankCache = (): Cache => ({ rows: [], pending: [], initialized: false });
// Separate from the immutable legacy database. Every account has its own cache and durable outbox.
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('hikari-desk-cloud-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('accounts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function cacheRead(user: string): Promise<Cache> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('accounts', 'readonly');
      const read = tx.objectStore('accounts').get(user);
      tx.oncomplete = () => resolve(read.result ?? blankCache());
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function cacheWrite(user: string, value: Cache) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('accounts', 'readwrite');
      tx.objectStore('accounts').put(value, user);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('待同步队列保存失败，本次写入未被接受。'));
    });
  } finally { db.close(); }
}
export async function exclusive<T>(user: string, task: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return Promise.reject(new Error('浏览器不支持可靠的多窗口写入锁，请更新浏览器。'));
  return await navigator.locks.request('hikari-desk-' + user, task);
}
