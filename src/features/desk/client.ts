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
    instance = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }) } });
  }
  return instance;
}
export async function owner() {
  const { data, error } = await client().auth.getSession();
  if (error || !data.session) throw new Error('请先登录数据中心。');
  return data.session.user.id;
}
