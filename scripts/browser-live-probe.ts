// Local acceptance harness, bundled only by prepare-live-probe.mjs; never an Astro page.
import { createClient } from '@supabase/supabase-js';
import { client } from '../src/features/desk/client.ts';

declare const __PROBE_CONFIG__: {
  expectedCaller: string; targetOwner: string;
  target: { kind: 'terms'; id: string; ordinal: number; version: number; payload: unknown };
};
const config = __PROBE_CONFIG__;
const account = document.querySelector<HTMLElement>('#account')!;
const results = document.querySelector<HTMLElement>('#results')!;
const run = document.querySelector<HTMLButtonElement>('#run')!;
const rows: { check: string; passed: boolean; code?: string }[] = [];
function record(check: string, passed: boolean, code?: string) {
  rows.push({ check, passed, ...(code ? { code } : {}) });
  results.textContent = JSON.stringify(rows, null, 2);
  if (!passed) throw new Error('验收未通过：' + check);
}
const verified = await client().auth.getUser();
if (verified.error || !verified.data.user) {
  account.textContent = '尚未登录。请先在同一地址的数据中心登录主账号。';
} else {
  account.textContent = '当前账号：' + verified.data.user.email;
  if (verified.data.user.id !== config.expectedCaller) {
    results.textContent = '当前不是预期的主账号；测试未运行。请在数据中心切换后刷新。';
  } else run.disabled = false;
}
run.addEventListener('click', async () => {
  run.disabled = true;
  try {
    const owner = await client().rpc('desk_snapshot');
    record('主账号可读取自己的空云端快照', !owner.error && Array.isArray(owner.data) && owner.data.length === 0, owner.error?.code);
    const foreignRead = await client().from('desk_entities').select('kind,id').eq('user_id', config.targetOwner);
    record('带其他用户 ID 的直接 API 查询不可读到数据', !foreignRead.error && foreignRead.data?.length === 0, foreignRead.error?.code);
    const foreignUpdate = await client().from('desk_entities').update({ payload: config.target.payload })
      .eq('user_id', config.targetOwner).eq('kind', config.target.kind).eq('id', config.target.id);
    record('直接 API 修改其他用户数据被拒绝', foreignUpdate.error?.code === '42501', foreignUpdate.error?.code);
    // This cannot delete an existing record even if a grant is wrong.
    const foreignDelete = await client().from('desk_entities').delete().eq('user_id', config.targetOwner)
      .eq('id', 'permission-probe-does-not-exist');
    record('直接 API 删除权限被拒绝', foreignDelete.error?.code === '42501', foreignDelete.error?.code);
    const foreignRpc = await client().rpc('desk_commit', { operation_id: crypto.randomUUID(), changes: [{
      kind: config.target.kind, id: config.target.id, ordinal: config.target.ordinal,
      payload: config.target.payload, expected: config.target.version, deleted: false, user_id: config.targetOwner,
    }] });
    record('伪造行归属不能通过 RPC 改动其他用户记录', foreignRpc.error?.code === '40001', foreignRpc.error?.code);
    const receipts = await client().from('desk_operations').select('id');
    record('登录用户不能直接读取操作收据', receipts.error?.code === '42501', receipts.error?.code);
    const anonymous = createClient(import.meta.env.PUBLIC_SUPABASE_URL, import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) } });
    const anonRead = await anonymous.rpc('desk_snapshot');
    record('匿名 API 读取被拒绝', anonRead.error?.code === '42501', anonRead.error?.code);
    const anonWrite = await anonymous.rpc('desk_commit', { operation_id: crypto.randomUUID(), changes: [] });
    record('匿名 API 写入被拒绝', anonWrite.error?.code === '42501', anonWrite.error?.code);
    const after = await client().rpc('desk_snapshot');
    record('主账号未因权限探测产生业务数据', !after.error && Array.isArray(after.data) && after.data.length === 0, after.error?.code);
    document.querySelector<HTMLElement>('#summary')!.textContent = '全部 9 项真实 API 权限检查通过。';
  } catch (error) {
    document.querySelector<HTMLElement>('#summary')!.textContent = error instanceof Error ? error.message : '检查失败。';
  }
});
