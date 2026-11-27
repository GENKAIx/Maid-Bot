import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_ACTIONS, ADMIN_SECTIONS, adminNavGroups, adminSection, testActs, testSeenText, type AccountCard, type TestsData } from "../src/admin.ts";
import { TestsPage, testKeyFlow, testsBridge } from "../src/screens/AdminTests.tsx";
import { AccountCardView, AccountGone } from "../src/screens/AdminAccount.tsx";

// «Тестовые аккаунты» (27.11.2026, server/src/admin-tests.ts; screens/AdminTests.tsx): раздел, подписи журнала, кнопки строки
// (в программе на ПК — «Войти в программе», в браузере — «Показать ключ»), логин и пароль один раз, сброс с набором номера.

const row = (id: number, extra: Partial<TestsData["items"][number]> = {}) => ({
  id, plan: "friend", created_at: "2026-11-27T09:00:00.000Z", frozen_at: null, last_seen: null, client: "", version: "", sessions: 0, ...extra,
});
const data = (items = [row(1201), row(1202, { last_seen: "2026-11-27T10:00:00.000Z", client: "desktop", version: "0.1.95", sessions: 1 })], max = 10): TestsData => ({ max, items });
const html = (props: Parameters<typeof TestsPage>[0]) => renderToStaticMarkup(createElement(TestsPage, props));

test("тестовые аккаунты: раздел в «Люди и деньги» сразу после «Аккаунта», живой, подписи действий журнала", () => {
  assert.equal(adminSection("tests"), "tests");
  const s = ADMIN_SECTIONS.find((x) => x.id === "tests")!;
  assert.equal(s.group, "Люди и деньги");
  assert.equal(s.stage, 0);
  assert.equal(s.icon, "adm-tests");
  const people = adminNavGroups().find((g) => g.group === "Люди и деньги")!.items.map((x) => x.id);
  assert.equal(people[people.indexOf("account") + 1], "tests");
  for (const a of ["test_create", "test_token", "test_reset"]) assert.ok(ADMIN_ACTIONS[a], a);
});

test("тестовые аккаунты: кнопки строки — в программе «Войти», в браузере «Показать ключ», замороженному ключа нет", () => {
  assert.deepEqual(testActs({ frozen_at: null }, true), ["enter", "reset", "card"]);
  assert.deepEqual(testActs({ frozen_at: null }, false), ["key", "reset", "card"]);
  assert.deepEqual(testActs({ frozen_at: "2026-11-27T10:00:00Z" }, true), ["reset", "card"]);
  const now = new Date("2026-11-27T12:00:00Z");
  assert.equal(testSeenText(row(1), now), "входов нет");
  assert.match(testSeenText(row(1, { last_seen: "2026-11-26T10:00:00Z", client: "desktop", version: "0.1.95", sessions: 1 }), now), /^Программа на ПК 0\.1\.95 · вчера$/);
  assert.match(testSeenText(row(1, { last_seen: "2026-11-26T10:00:00Z", sessions: 1 }), now), /^вход · вчера$/);
});

test("тестовые аккаунты: «Войти в программе на ПК» — только при мосте программы, иначе «Показать ключ»", async () => {
  const inBrowser = html({ data: data(), enter: null });
  assert.ok(inBrowser.includes("Показать ключ"));
  assert.ok(!inBrowser.includes("Войти в программе на ПК"));
  const inApp = html({ data: data(), enter: async () => ({ ok: true }) });
  assert.ok(inApp.includes("Войти в программе на ПК"));
  assert.ok(!inApp.includes("Показать ключ"));
  // Мост: только когда программа на ПК его выставила (desktop/src/preload-app.js maidDesktop.enterTest).
  const g = globalThis as { window?: unknown };
  const was = g.window;
  try {
    g.window = {};
    assert.equal(testsBridge(), null, "в браузере моста нет");
    g.window = { maidDesktop: { widget: async () => null } };
    assert.equal(testsBridge(), null, "старая программа без enterTest");
    let got = "";
    g.window = { maidDesktop: { enterTest: async (t: string) => ((got = t), { ok: true }) } };
    const enter = testsBridge();
    assert.ok(enter);
    assert.deepEqual(await enter!("k".repeat(43)), { ok: true });
    assert.equal(got, "k".repeat(43));
  } finally {
    g.window = was;
  }
});

test("тестовые аккаунты: список — только #id и числа; логин и пароль — один раз после создания, с копированием", () => {
  const list = html({ data: data(), enter: null });
  for (const id of ["#1201", "#1202"]) assert.ok(list.includes(id), id);
  assert.ok(list.includes("Программа на ПК 0.1.95"));
  assert.ok(list.includes("Аккаунт #1202"), "ссылка в карточку (удаление — там)");
  assert.ok(!/Логин|Пароль|test-/.test(list), "в списке нет логина и пароля");
  const shown = html({ data: data(), enter: null, secret: { id: 1203, login: "test-a1b2c3", password: "Qw3rty_123" } });
  assert.ok(shown.includes("test-a1b2c3") && shown.includes("Qw3rty_123"));
  assert.ok(shown.includes("Видны один раз"));
  assert.ok(shown.includes("Копировать"));
  assert.ok(shown.includes("Сохранил — скрыть"));
  const key = html({ data: data(), enter: null, secret: { id: 1201, token: "x".repeat(43) } });
  assert.ok(key.includes("x".repeat(43)) && key.includes("Ключ для программы на ПК — #1201"));
});

test("тестовые аккаунты: потолок — «Создать» серая; пустой список — подсказка", () => {
  const full = html({ data: data(Array.from({ length: 10 }, (_, i) => row(1300 + i))), enter: null });
  assert.match(full, /<button class="adm-btn primary" disabled="">Создать тестовый<\/button>/);
  assert.ok(full.includes("10 из 10 — удалите ненужный"));
  const empty = html({ data: data([]), enter: null });
  assert.ok(empty.includes("Тестовых аккаунтов нет"));
  assert.ok(empty.includes("0 из 10"));
});

test("тестовые аккаунты: «Сбросить к чистому» — предупреждение и номер вручную (вставка выключена), пока не набран — серая", () => {
  const open = html({ data: data(), enter: null, open: 1202 });
  assert.ok(open.includes("Наберите номер аккаунта: 1202"));
  assert.ok(open.includes("Номер, логин и пароль останутся"));
  assert.match(open, /<button type="submit" class="adm-btn danger" disabled="">Сбросить #1202<\/button>/);
  assert.equal((open.match(/Наберите номер аккаунта/g) ?? []).length, 2, "поле одно: подсказка и подпись");
});

test("тестовые аккаунты: ключ — в программе сразу ей и не на экран; в браузере — показать один раз", async () => {
  const token = "T".repeat(43);
  const b = await testKeyFlow(1201, token, null);
  assert.deepEqual(b.secret, { id: 1201, token });
  assert.ok(b.note?.ok);
  let got = "";
  const ok = await testKeyFlow(1201, token, async (t) => ((got = t), { ok: true }));
  assert.equal(got, token);
  assert.equal(ok.secret, null);
  assert.ok(ok.note?.ok && ok.note.text.includes("Вернуться в свой аккаунт"));
  assert.ok(!ok.note!.text.includes(token), "ключа нет в итоге");
  const no = await testKeyFlow(1201, token, async () => ({ ok: false, error: "это не тестовый аккаунт" }));
  assert.equal(no.secret, null);
  assert.ok(!no.note?.ok && no.note!.text.includes("это не тестовый аккаунт") && !no.note!.text.includes(token));
  const thrown = await testKeyFlow(1201, token, async () => { throw new Error("окно закрыто"); });
  assert.ok(!thrown.note?.ok && thrown.note!.text.includes("окно закрыто"));
  const nil = await testKeyFlow(1201, token, async () => null);
  assert.ok(!nil.note?.ok && nil.note!.text.includes("нет ответа"));
});

test("карточка аккаунта: метка «тестовый» и путь в раздел; у обычного — нет", () => {
  const card: AccountCard = {
    id: 1201, created_at: "2026-11-27T09:00:00.000Z", days_with_us: 0, plan: "friend", kind: null, until: null, canceled: false, live_sub: false,
    frozen_at: null, protected: false, ended: null, today: null, payments: [], events: [], week: [], devices: [], last_seen: null, log: [
      { at: "2026-11-27T09:00:00.000Z", who: "#1", action: "test_create", detail: "#1201", reason: "проверка виджета" },
    ], is_test: 1,
  };
  const t = renderToStaticMarkup(createElement(AccountCardView, { card, onCard: () => {} }));
  assert.ok(t.includes(">тестовый</span>"));
  assert.ok(t.includes("/admin/tests"));
  assert.ok(t.includes(ADMIN_ACTIONS.test_create), "строка журнала подписана");
  const plain = renderToStaticMarkup(createElement(AccountCardView, { card: { ...card, is_test: 0 }, onCard: () => {} }));
  assert.ok(!plain.includes(">тестовый</span>") && !plain.includes("/admin/tests"));
  assert.ok(renderToStaticMarkup(createElement(AccountGone, { id: 1201, text: "Удалено.", test: true })).includes("Тестовых аккаунтах"));
  assert.ok(renderToStaticMarkup(createElement(AccountGone, { id: 5, text: "Удалено." })).includes("С того же Telegram"));
});
