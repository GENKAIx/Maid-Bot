import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ADMIN_ACTIONS, ADMIN_SECTIONS, ALERT_LOG_KINDS, adminSection, alertState, alertThresholdError, alertValueText, bytesText, copyStatus,
  type AlertsData, type BackupsData,
} from "../src/admin.ts";
import { AlertsPage, BackupsPage } from "../src/screens/AdminAlerts.tsx";

// Этап 4 «Тарифы и управление»: разделы «Оповещения» и «Копии базы» в «Системе», подписи журнала, форматы и рендер по готовым данным.

const RULE = {
  id: "spend_day", title: "Расход на ИИ за день (UTC) — от", unit: "$", kind: "state" as const, hint: "80% потолка", recover: false, window: false,
  min: 0.01, max: 10_000, int: false, enabled: true, threshold: 8, window_min: 1440, every_min: 360, firing: 2, last_sent: "2026-11-24T10:00:00Z", last_value: 9.5, updated_at: "",
};

test("админка, этап 4: «Оповещения» и «Копии базы» — в «Системе», подписи действий и истории", () => {
  for (const id of ["alerts", "backups"] as const) {
    assert.equal(adminSection(id), id);
    assert.equal(ADMIN_SECTIONS.find((s) => s.id === id)!.group, "Система");
  }
  for (const a of ["alert_rule", "alert_test", "alert_check", "backup_run", "backup_verify"]) assert.ok(ADMIN_ACTIONS[a], a);
  for (const k of ["fire", "repeat", "ok", "held", "test"]) assert.ok(ALERT_LOG_KINDS[k], k);
});

test("оповещения: состояние, значение с единицей, проверка порога", () => {
  assert.deepEqual(alertState({ enabled: false, firing: 2 }), { text: "выключено", tone: "mute" });
  assert.equal(alertState({ enabled: true, firing: 2 }).tone, "bad");
  assert.equal(alertState({ enabled: true, firing: 1 }).tone, "warn");
  assert.equal(alertState({ enabled: true, firing: 0 }).text, "норма");
  assert.equal(alertValueText({ unit: "$", last_value: 9.5 }), "$9.50");
  assert.equal(alertValueText({ unit: "%", last_value: 25 }), "25%");
  assert.equal(alertValueText({ unit: "шт.", last_value: 3 }), "3 шт.");
  assert.equal(alertValueText({ unit: "шт.", last_value: null }), "—");
  assert.equal(alertThresholdError({ min: 1, max: 100, int: true }, "20"), null);
  assert.equal(alertThresholdError({ min: 1, max: 100, int: true }, "2.5"), "целое число");
  assert.equal(alertThresholdError({ min: 0.01, max: 100, int: false }, "2,5"), null);
  assert.equal(alertThresholdError({ min: 1, max: 100, int: true }, "0"), "от 1 до 100");
  assert.equal(alertThresholdError({ min: 1, max: 100, int: true }, ""), "нужно число");
});

test("копии базы: размер и итог копии одной фразой", () => {
  assert.equal(bytesText(null), "—");
  assert.equal(bytesText(512), "512 Б");
  assert.equal(bytesText(3.4 * 1024), "3,4 КБ");
  assert.equal(bytesText(184 * 1024 * 1024), "184 МБ");
  const c = { kind: "copy" as const, status: "ok" as const, problem: "", sent: 1 };
  assert.deepEqual(copyStatus(c), { text: "на сервере и в Telegram", tone: "ok" });
  assert.equal(copyStatus({ ...c, problem: "не влезает", sent: 0 }).tone, "warn");
  assert.equal(copyStatus({ ...c, status: "fail" }).text, "не снялась");
  assert.equal(copyStatus({ ...c, kind: "verify", status: "fail" }).text, "не поднимается");
  assert.equal(copyStatus({ ...c, status: "skip" }).text, "пропущено");
});

test("разделы рисуются по готовым данным: правила, история, копии и проверки", () => {
  const alerts: AlertsData = {
    check_every_min: 5, rules: [RULE, { ...RULE, id: "payment", title: "Новые оплаты — от", unit: "шт.", kind: "event", enabled: false, firing: 0, threshold: 1, last_value: null }],
    history: [{ at: "2026-11-24T10:00:00Z", rule: "spend_day", kind: "fire", value: 9.5, text: "⚠️ Расход на ИИ сегодня (UTC): $9.50", sent: true }],
  };
  const a = renderToStaticMarkup(createElement(AlertsPage, { data: alerts, onChanged: () => {}, note: null, setNote: () => {} }));
  assert.match(a, /Проверить сейчас/);
  assert.match(a, /Тестовое оповещение/);
  assert.match(a, /Расход на ИИ за день/);
  assert.match(a, /\$9\.50/);
  assert.match(a, /тревога/);
  assert.match(a, /выключено/);
  assert.match(a, /сработало/);
  const backups: BackupsData = {
    mode: "sqlite", at: "04:00", keep: 14, telegram: true, max_send_bytes: 50 * 1024 * 1024, db_bytes: 12 * 1024 * 1024,
    local: [{ file: "maid-2026-11-24.sqlite", bytes: 12 * 1024 * 1024, at: "2026-11-24T01:00:00Z" }],
    copies: [{ at: "2026-11-24T01:00:00Z", kind: "copy", status: "ok", file: "maid-2026-11-24.sqlite", bytes: 12 * 1024 * 1024, gz_bytes: 3 * 1024 * 1024, sent: 1, problem: "", note: "", by_user: 0, ms: 900 }],
    verifies: [],
  };
  const b = renderToStaticMarkup(createElement(BackupsPage, { data: backups, onChanged: () => {}, note: null, setNote: () => {} }));
  assert.match(b, /Проверить восстановление/);
  assert.match(b, /Сделать копию сейчас/);
  assert.match(b, /ни разу/);
  assert.match(b, /на сервере и в Telegram/);
  assert.match(b, /сжатая 3,0 МБ/);
  const pg = renderToStaticMarkup(createElement(BackupsPage, { data: { ...backups, mode: "postgres", local: [], copies: [] }, onChanged: () => {}, note: null, setNote: () => {} }));
  assert.match(pg, /копии делает провайдер/);
  // Таблица «На сервере» — в прокрутке, как остальные: длинное имя файла не растягивает страницу на телефоне.
  assert.match(b, /<b>На сервере<\/b><div class="adm-scroll"><table/);
});

test("итог действия приходит от родителя и виден на свежей странице (после действия она перемонтируется)", () => {
  const alerts: AlertsData = { check_every_min: 5, rules: [RULE], history: [] };
  const a = renderToStaticMarkup(createElement(AlertsPage, { data: alerts, onChanged: () => {}, note: { ok: false, text: "Не ушло: бот выключен или у владельца нет Telegram." }, setNote: () => {} }));
  assert.match(a, /role="alert">Не ушло: бот выключен/);
  const backups: BackupsData = { mode: "sqlite", at: "04:00", keep: 14, telegram: true, max_send_bytes: 1, db_bytes: 1, local: [], copies: [], verifies: [] };
  const b = renderToStaticMarkup(createElement(BackupsPage, { data: backups, onChanged: () => {}, note: { ok: true, text: "проверено — в копии людей 3" }, setNote: () => {} }));
  assert.match(b, /role="status">проверено — в копии людей 3/);
});
