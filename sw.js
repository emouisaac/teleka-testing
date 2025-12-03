self.addEventListener('push', function(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Notification', body: event.data ? String(event.data) : '' }; }
  const title = data.title || 'Teleka Notification';
  const options = Object.assign({
    body: data.body || '',
    icon: '/ims/1110.png',
    badge: '/ims/1110.png',
    data: data.data || {},
    requireInteraction: true
  }, data.options || {});

  // Provide sensible defaults that improve visibility on mobile/Android
  options.vibrate = options.vibrate || [200, 100, 200];
  options.tag = options.tag || 'teleka-notify';
  if (typeof options.renotify === 'undefined') options.renotify = true;
  // Include a timestamp in the notification data to help clients dedupe/inspect
  options.data = Object.assign({ ts: Date.now() }, options.data || {});

  // Ensure both the system notification and client postMessage are awaited
  event.waitUntil((async () => {
    try{
      await self.registration.showNotification(title, options);
    }catch(e){ /* ignore showNotification errors */ }

    try{
      const all = await clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for(const c of all){
        try{ c.postMessage({ type: 'push', data }); }catch(e){}
      }
    }catch(e){ /* ignore */ }
  })());
});

// When a push subscription is invalidated (browser/platform may trigger this), log and
// attempt to re-subscribe where possible. Note: re-subscription requires the app
// server's applicationServerKey (VAPID public key) and may need coordination with the
// page context. This handler helps surface events for debugging.
self.addEventListener('pushsubscriptionchange', function(event){
  console.warn('[sw] pushsubscriptionchange', event);
  // Best-effort attempt to re-subscribe; this will succeed only if the browser
  // allows and if the page/service-worker environment can access the VAPID key.
  event.waitUntil((async () => {
    try{
      const reg = await self.registration;
      // NOTE: applicationServerKey is not known here reliably; this will often fail.
      // Leaving this as a no-op fallback to ensure the event is not ignored silently.
      // A robust approach is to have the page detect subscription loss and re-subscribe.
      console.info('[sw] pushsubscriptionchange handled - recommend re-subscribing from page context');
    }catch(e){ console.warn('[sw] pushsubscriptionchange error', e); }
  })());
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
    for (let i = 0; i < windowClients.length; i++) {
      const client = windowClients[i];
      if (client.url === url && 'focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});


