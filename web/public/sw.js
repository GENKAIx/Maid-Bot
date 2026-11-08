// Service worker: показывает push-уведомления и выполняет кнопки без открытого приложения.
// Кнопка — подписанный сервером список (act) и номер действия; вход не нужен.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "Горничная", body: e.data ? e.data.text() : "" };
  }
  const actions = (data.actions || []).map((a) => ({ action: a.action, title: a.title }));
  e.waitUntil(
    self.registration.showNotification(data.title || "Горничная", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icon-180.png",
      badge: "/icon-180.png",
      data: { url: data.url || "/", act: data.act || "", actions },
      actions,
      renotify: Boolean(data.tag),
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const d = n.data || {};
  n.close();
  if (e.action && d.act) {
    e.waitUntil(
      fetch("/api/push/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ act: d.act, action: Number(e.action) }),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((r) => self.registration.showNotification("Горничная", { body: r.text || r.error || "Готово", tag: "maid-ack", icon: "/icon-180.png" }))
        .catch(() => self.registration.showNotification("Горничная", { body: "Нет связи с сервером", tag: "maid-ack", icon: "/icon-180.png" })),
    );
    return;
  }
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => "focus" in c);
      if (open) return open.focus().then((c) => ("navigate" in c ? c.navigate(d.url || "/") : c));
      return self.clients.openWindow(d.url || "/");
    }),
  );
});
