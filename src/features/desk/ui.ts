import { cloudEnabled, client } from './client.ts';
import { fenceLegacy, legacyRaw } from './migration.ts';
export async function prepareDesk(root: HTMLElement, content: HTMLElement) {
  if (!cloudEnabled) return;
  root.querySelector('nav')?.setAttribute('inert', '');
  const panel = document.createElement('section');
  panel.className = 'study-card';
  panel.setAttribute('aria-label', '统一数据层');
  panel.innerHTML = '<p role="status" data-sync>正在检查登录…</p><a href="/desk/data/">数据中心 · 迁移与备份</a>';
  content.before(panel);
  const status = panel.querySelector<HTMLElement>('[data-sync]')!;
  const raw = document.createElement('button'); raw.type = 'button'; raw.className = 'study-action'; raw.textContent = '导出原始旧数据';
  raw.addEventListener('click', async () => {
    try {
      const blob = new Blob([JSON.stringify(await legacyRaw(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = 'hikari-legacy-raw-' + new Date().toISOString().slice(0,10) + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { status.textContent = String(error); }
  }); panel.append(raw);
  const names = { synced: '已同步', pending: '待同步', offline: '离线，使用缓存', failed: '同步失败，将自动重试', conflict: '存在冲突，请在数据中心处理' };
  window.addEventListener('desk-sync', event => {
    const detail = (event as CustomEvent).detail;
    status.textContent = names[detail.state as keyof typeof names] + (detail.count ? `（${detail.count} 项待同步）` : '') +
      (detail.detail ? '。' + detail.detail : '');
  });
  const { data, error } = await client().auth.getSession();
  if (error) throw error;
  if (!data.session) {
    client().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) location.reload();
    });
    status.textContent = '登录后访问统一的私人学习数据。';
    content.replaceChildren();
    const form = document.createElement('form');
    form.innerHTML = '<label class="study-field">邮箱<input type="email" name="email" autocomplete="username" required></label>' +
      '<label class="study-field">密码<input type="password" name="password" autocomplete="current-password" required></label>' +
      '<button class="study-action primary" type="submit">登录</button><p role="alert"></p>';
    panel.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button')!; button.disabled = true;
      try {
        const fields = new FormData(form);
        const { error } = await client().auth.signInWithPassword({ email: String(fields.get('email')), password: String(fields.get('password')) });
        if (error) throw error;
        location.reload();
      } catch (error) { form.querySelector('p')!.textContent = error instanceof Error ? error.message : '登录失败。'; }
      finally { button.disabled = false; }
    });
    // Legacy raw export is available before login, including when Supabase cannot be reached.
    const backup = document.createElement('a'); backup.href = '/desk/data/#legacy'; backup.textContent = '导出当前浏览器原始旧数据'; panel.append(backup);
    await new Promise<void>(() => {});
  }
  const account = document.createElement('p');
  account.textContent = '当前账号：' + (data.session!.user.email ?? '已验证账号');
  panel.prepend(account);
  await fenceLegacy();
  status.textContent = '正在读取云端数据…';
  const logout = document.createElement('button');
  logout.type = 'button'; logout.className = 'study-action'; logout.textContent = '退出登录';
  logout.addEventListener('click', async () => {
    // First hide private data, even if the remote sign-out request cannot complete.
    root.setAttribute('inert', ''); root.replaceChildren();
    await client().auth.signOut({ scope: 'local' }); location.reload();
  });
  panel.append(logout);
  client().auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || session && session.user.id !== data.session?.user.id) {
      root.setAttribute('inert', ''); root.replaceChildren(); location.reload();
    }
  });
  // Clear pages restored from the back-forward cache before displaying a previous account.
  window.addEventListener('pageshow', event => { if (event.persisted) { root.replaceChildren(); location.reload(); } });
  root.querySelector('nav')?.removeAttribute('inert');
}
