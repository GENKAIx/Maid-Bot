import assert from "node:assert/strict";
import { test } from "node:test";
import { refundable, starsText, PAYMENT_KINDS, ADMIN_SECTIONS, adminSection, type PaymentRow } from "../src/admin.ts";
import { api, ApiError, getToken, setToken, whenUnauthorized } from "../src/api.ts";
import { isPayUrl, planView, refusedOf, refusedView, type Access } from "../src/billing.ts";

// Платный доступ на сайте (24.11.2026): 402 — не выход со входа (ключ остаётся), а отказ ИИ со ссылкой на оплату;
// блок «Тариф» в настройках (planView) и раздел «Оплаты» в админке (refundable, starsText).

// Маленькое хранилище вместо localStorage браузера и подменённый fetch.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
};
const answer = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
};
const errOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

test("402: ключ остаётся, выхода нет; ошибка несёт текст, ссылку и записанную заметку", async () => {
  setToken("good-key");
  let out = 0;
  whenUnauthorized(() => out++);
  answer(402, { error: "Пробная неделя закончилась — я сохранила всё, что было.", pay_url: "https://t.me/$abc123", messageId: 42, saved: true });
  const e = await errOf(api("POST", "/api/input", { text: "купить хлеб" }));
  assert.ok(e instanceof ApiError && e.status === 402);
  assert.equal(getToken(), "good-key", "402 не стирает ключ");
  assert.equal(out, 0, "402 не выкидывает на вход");
  assert.deepEqual(refusedOf(e), { text: "Пробная неделя закончилась — я сохранила всё, что было.", payUrl: "https://t.me/$abc123", messageId: 42, saved: true });

  // 429 (слишком часто, лимит дня) — тоже отказ, но без ссылки, даже если сервер её прислал.
  answer(429, { error: "Не так быстро", pay_url: "https://t.me/$x", messageId: 7, saved: true });
  const r429 = refusedOf(await errOf(api("POST", "/api/input", {})));
  assert.equal(r429?.payUrl, null);
  assert.equal(r429?.saved, true);

  // Голос отклонён до распознавания — ничего не записано.
  answer(402, { error: "нужна подписка", pay_url: null });
  assert.deepEqual(refusedOf(await errOf(api("POST", "/api/voice", {}))), { text: "нужна подписка", payUrl: null, messageId: null, saved: false });

  // Чужая ссылка в ответе не открывается.
  answer(402, { error: "x", pay_url: "https://evil.example/t.me/" });
  assert.equal(refusedOf(await errOf(api("POST", "/api/input", {})))?.payUrl, null);

  // 401 — как и раньше: ключ стёрт, вход.
  answer(401, { error: "нужен вход" });
  await errOf(api("GET", "/api/today"));
  assert.equal(getToken(), "");
  assert.equal(out, 1);

  // Другие ошибки — не отказ ИИ.
  answer(500, { error: "ошибка сервера" });
  assert.equal(refusedOf(await errOf(api("GET", "/api/today"))), null);
  assert.equal(refusedOf(new Error("нет связи")), null);
});

test("ссылка на оплату — только https://t.me/…", () => {
  for (const u of ["https://t.me/$abc", "https://t.me/invoice/xyz"]) assert.ok(isPayUrl(u), u);
  for (const u of ["http://t.me/$abc", "https://t.me.evil.com/$a", "javascript:alert(1)", "https://t.me/", "https://t.me/a b", null, 5, `https://t.me/${"a".repeat(600)}`]) {
    assert.ok(!isPayUrl(u), String(u));
  }
});

test("«Тариф»: что показать и какие кнопки на каждом плане", () => {
  const a = (x: Partial<Access>): Access => ({ plan: "expired", until: null, canceled: false, trial_left_days: null, ...x });
  const owner = planView(a({ plan: "owner" }));
  assert.equal(owner.title, "Владелец");
  assert.ok(!owner.pay && !owner.cancel);
  const friend = planView(a({ plan: "friend" }));
  assert.ok(/навсегда/.test(friend.text) && !friend.pay && !friend.cancel);

  const trial = planView(a({ plan: "trial", until: "2026-12-01T10:00:00Z", trial_left_days: 3 }));
  assert.equal(trial.title, "Пробный период");
  assert.ok(trial.text.startsWith("Осталось 3 дня"), trial.text);
  assert.ok(trial.text.includes("⭐150"));
  assert.ok(trial.pay && !trial.cancel);
  assert.ok(planView(a({ plan: "trial", trial_left_days: 1 })).text.startsWith("Осталось 1 день"));
  assert.ok(planView(a({ plan: "trial", trial_left_days: 5 })).text.startsWith("Осталось 5 дней"));
  assert.ok(planView(a({ plan: "trial", trial_left_days: 0 })).text.startsWith("Осталось 0 дней"));

  const paid = planView(a({ plan: "paid", until: "2026-12-24T10:00:00Z" }));
  assert.ok(paid.cancel && !paid.pay, "подписка: только отмена продления");
  // Отменённая, но идущая — второй оплаты не предлагаем (списало бы дважды), только как возобновить в Telegram.
  const canceled = planView(a({ plan: "paid", until: "2026-12-24T10:00:00Z", canceled: true }));
  assert.ok(!canceled.cancel && !canceled.pay && canceled.resume && /Мои звёзды/.test(canceled.text), "отменённая — «Возобновить продление»");
  assert.ok(!paid.resume && !trial.resume);

  const expired = planView(a({ plan: "expired" }));
  assert.ok(expired.pay && !expired.cancel && /бесплатно/.test(expired.text));
  assert.ok(planView(a({ plan: "expired" }), 200).text.includes("⭐200"));
  // Старый сервер без access — не падаем.
  assert.equal(planView(undefined).pay, false);
});

test("админка: раздел «Оплаты», суммы, кнопка возврата — у последней невозвращённой оплаты человека", () => {
  assert.equal(adminSection("payments"), "payments");
  assert.ok(ADMIN_SECTIONS.some((s) => s.id === "payments" && s.title === "Оплаты"));
  assert.equal(starsText(150), "⭐150");
  assert.equal(starsText(3, "USD"), "3 USD");
  assert.equal(PAYMENT_KINDS.renew, "Продление");
  const row = (user_id: number, paid_at: string, refunded_at: string | null = null): PaymentRow =>
    ({ user_id, name: `u${user_id}`, amount: 150, currency: "XTR", kind: "renew", paid_at, expires_at: null, refunded_at, charge: "…12345678" });
  const rows = [row(1, "2026-11-20"), row(2, "2026-11-19", "2026-11-21"), row(1, "2026-10-20"), row(2, "2026-10-19")];
  assert.deepEqual(rows.map((_, i) => refundable(rows, i)), [true, false, false, true]);
  assert.equal(refundable(rows, 9), false);
});

test("строка ввода и отказ: заметка записана — строка очищается и «↩» есть; голос до распознавания — текст остаётся; 402 со ссылкой — не красное", () => {
  const saved = refusedView({ text: "x", payUrl: "https://t.me/$a", messageId: 5, saved: true });
  assert.deepEqual(saved, { clear: true, error: false, undoId: 5 });
  const voice = refusedView({ text: "x", payUrl: "https://t.me/$a", messageId: null, saved: false });
  assert.deepEqual([voice.clear, voice.undoId, voice.error], [false, null, false]);
  const money = refusedView({ text: "лимит", payUrl: null, messageId: 7, saved: true });
  assert.deepEqual([money.clear, money.error, money.undoId], [true, true, 7]);
  assert.deepEqual(refusedView(null), { clear: false, error: true, undoId: null });
});
