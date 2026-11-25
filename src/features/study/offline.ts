export function setupOffline(status: HTMLElement) {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  let hadController = !!navigator.serviceWorker.controller;
  const showReady = () => {
    status.textContent = '已就绪，可离线使用。';
    status.hidden = true;
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      showReady();
      return;
    }
    status.replaceChildren('学习工作台已有新版本。 ');
    const reload = document.createElement('button');
    reload.className = 'study-action';
    reload.textContent = '刷新使用新版';
    reload.addEventListener('click', () => location.reload());
    status.append(reload);
    status.hidden = false;
  });
  void navigator.serviceWorker.register('/desk/study/sw.js', { scope: '/desk/study/', updateViaCache: 'none' })
    .then(registration => {
      if (!navigator.serviceWorker.controller) {
        status.textContent = '正在准备离线使用。';
        status.hidden = false;
      }
      const watchInstallation = () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'redundant' && !navigator.serviceWorker.controller) {
            status.textContent = '离线准备未完成。请在联网时重新打开工作台。';
            status.hidden = false;
          }
        });
      };
      watchInstallation();
      registration.addEventListener('updatefound', watchInstallation);
      let checkedAt = 0;
      const check = () => {
        if (navigator.onLine && Date.now() - checkedAt > 300_000) {
          checkedAt = Date.now();
          void registration.update().catch(() => { /* 继续使用已安装的版本 */ });
        }
      };
      window.addEventListener('online', check);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    }).catch(() => {
      if (!navigator.serviceWorker.controller) {
        status.textContent = '离线准备未完成。联网时可以继续使用工作台。';
        status.hidden = false;
      }
    });
}
