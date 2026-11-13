(() => {
  'use strict';
  const button = document.getElementById('pwa-install');
  const bar = document.getElementById('pwa-bar');
  const status = document.getElementById('pwa-status');
  const dialog = document.getElementById('pwa-help');
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let promptEvent = null;
  let offlineReady = false;
  let updateReady = false;
  function refresh() {
    bar.hidden = standalone();
    status.textContent = updateReady ? '🌷 有新版本，關閉所有手帳視窗後重新開啟即可更新。'
      : offlineReady ? (navigator.onLine ? '🌿 離線功能已準備好，沒網路也能記錄。' : '🍃 目前離線，紀錄會保存在這台裝置。')
      : '🌱 正在準備離線功能，第一次請保持連線。';
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); promptEvent = event; refresh();
  });
  window.addEventListener('appinstalled', () => {promptEvent = null;bar.hidden = true;});
  button.addEventListener('click', async () => {
    if (!promptEvent) {dialog.showModal(); return;}
    const deferred = promptEvent; promptEvent = null;
    try {await deferred.prompt(); await deferred.userChoice;}
    catch (error) {dialog.showModal();}
  });
  document.getElementById('pwa-help-close').addEventListener('click', () => dialog.close());
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
  matchMedia('(display-mode: standalone)').addEventListener('change', refresh);
  refresh();
  if (!('serviceWorker' in navigator) || !['https:', 'http:'].includes(location.protocol)) {
    status.textContent = '請使用正式網站網址開啟，才能安裝與準備離線功能。'; return;
  }
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', {scope: './', updateViaCache: 'none'});
      if (registration.waiting && navigator.serviceWorker.controller) {updateReady = true;refresh();}
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {updateReady = true;refresh();}
          if (worker.state === 'redundant' && !offlineReady) {
            status.textContent = '離線準備尚未完成，請保持連線並重新開啟一次。';
          }
        });
      });
      await navigator.serviceWorker.ready;
      offlineReady = true; refresh();
    } catch (error) {
      status.textContent = '目前仍可在線上記錄；離線準備未完成，請稍後重新開啟。';
      console.warn('小日子離線功能準備失敗', error);
    }
  });
})();
