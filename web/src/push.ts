import { get, post } from "./api";

// Подписка браузера на push: service worker регистрируется при запуске, подписка — по кнопке в настройках
// (iPhone просит разрешение только из установленного на экран «Домой» приложения).

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

export async function registerSw() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (e) {
    console.warn("sw", e);
    return null;
  }
}

function toKey(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  const reg = await navigator.serviceWorker?.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Попросить разрешение, подписаться и сообщить серверу. Возвращает текст ошибки или пусто. */
export async function subscribe(label: string): Promise<string> {
  if (!pushSupported()) return "Этот браузер не умеет push-уведомления.";
  const { key } = await get<{ key: string }>("/api/push/key");
  if (!key) return "На сервере не заданы ключи VAPID (npm --workspace server run vapid).";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Разрешение на уведомления не дано.";
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSw());
  if (!reg) return "Service worker не зарегистрирован.";
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(key) as BufferSource }));
  const j = sub.toJSON();
  await post("/api/push/subscribe", { endpoint: j.endpoint, keys: j.keys, label });
  return "";
}

export async function unsubscribe() {
  const sub = await currentSubscription();
  if (!sub) return;
  await post("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
