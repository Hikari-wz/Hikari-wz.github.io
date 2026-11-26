const studyRoute = '/desk/study/';
const readinessMessage = 'hikari-study-offline-schema';
const upgradeError = '学习工作台的离线版本尚未更新，原数据仍可在旧版使用。请联网后重试。';

function supportsSchema(worker: ServiceWorker | null, schema: number): Promise<boolean> {
  if (worker?.state !== 'activated') return Promise.resolve(false);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const done = (ready: boolean) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(ready);
    };
    const timeout = setTimeout(() => done(false), 750);
    channel.port1.onmessage = event => done(event.data?.schema >= schema && event.data.cached === true);
    try {
      worker.postMessage(readinessMessage, [channel.port2]);
    } catch {
      done(false);
    }
  });
}

export async function prepareStudyMigration(database: string, schema: number) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration(studyRoute);
  if (!registration || new URL(registration.scope).pathname !== studyRoute) return;
  if (typeof indexedDB.databases === 'function') {
    const installed = (await indexedDB.databases()).find(item => item.name === database);
    if (installed?.version && installed.version >= schema) return;
  }

  if (await supportsSchema(registration.active, schema)) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const ready = async () => {
    await registration.update();
    while (registration.installing || registration.waiting || registration.active?.state === 'activating') {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (expired) return false;
    }
    return supportsSchema(registration.active, schema);
  };
  try {
    const succeeded = await Promise.race([
      ready(),
      new Promise<false>(resolve => { timeout = setTimeout(() => { expired = true; resolve(false); }, 15_000); }),
    ]);
    if (succeeded) return;
  } catch {
    // A failed worker update leaves the previous shell and its database available offline.
  } finally {
    clearTimeout(timeout);
  }
  throw new Error(upgradeError);
}
