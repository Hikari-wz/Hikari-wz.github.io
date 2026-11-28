import { createClient, type SupabaseClient } from '@supabase/supabase-js';
export const cloudEnabled = import.meta.env?.PUBLIC_DESK_DATA_MODE === 'cloud';
let instance: SupabaseClient | undefined;
export function client() {
  if (!instance) {
    const url = import.meta.env?.PUBLIC_SUPABASE_URL;
    const key = import.meta.env?.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error('云端数据层未配置，请配置 Supabase URL 和 Publishable Key。');
    if (key.startsWith('sb_secret_')) throw new Error('禁止在前端使用 Secret Key。');
    if (key.split('.').length === 3) {
      try { if (JSON.parse(atob(key.split('.')[1])).role !== 'anon') throw new Error('禁止使用高权限 Key。'); }
      catch { throw new Error('客户端 Key 无效或权限过高。'); }
    }
    const storageUrl = new URL(url.replace(/\/$/, '') + '/storage/v1/object/desk-prep-files/');
    instance = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: (input, init) => {
        const request = input instanceof Request ? input : undefined;
        const target = new URL(request?.url ?? String(input), url);
        const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
        const transfer = target.origin === storageUrl.origin && target.pathname.startsWith(storageUrl.pathname) &&
          (method === 'POST' || method === 'GET');
        const timeout = AbortSignal.timeout(transfer ? 300_000 : 15_000);
        const signal = init?.signal ?? request?.signal;
        return fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } } });
  }
  return instance;
}
export async function owner() {
  const { data, error } = await client().auth.getSession();
  if (error || !data.session) throw new Error('请先登录数据中心。');
  return data.session.user.id;
}
