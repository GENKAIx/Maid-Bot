import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// Перетащили план на другой день в полосе виджета ПК — на том дне появляется копия, исходный остаётся.

test("копия и перенос плана: на новый день с тем же временем, без дублей, чужой не трогается", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const ev = await store.addEvent({ user_id: u.id, title: "Дать таблетку коту", date_iso: "2026-11-10", time: "14:00", end_time: "14:15", details: "полтаблетки", domain: "", message_id: null });
  const other = await store.addEvent({ user_id: (await store.ensureUser("200", "Чужой", "Europe/Moscow")).id, title: "Чужой", date_iso: "2026-11-10", time: null, end_time: null, details: "", domain: "", message_id: null });

  const pipe = new Pipeline(store, async () => "{}");
  const server = createApi({ store, pipeline: pipe }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  try {
    const token = (await call("/api/login", { login: "owner", password: "secret-pass-1", label: "test" })).json.token as string;

    const c = await call(`/api/events/${ev}/copy`, { date: "2026-11-12" }, token);
    assert.equal(c.status, 200);
    assert.equal(c.json.date_iso, "2026-11-12");
    assert.equal(c.json.time, "14:00");
    assert.equal(c.json.end_time, "14:15");
    assert.equal(c.json.details, "полтаблетки");
    assert.notEqual(c.json.id, ev);
    assert.equal((await store.event(ev))!.date_iso, "2026-11-10", "исходный план остался на месте");

    const again = await call(`/api/events/${ev}/copy`, { date: "2026-11-12" }, token);
    assert.equal(again.json.duplicate, true);
    assert.equal((await store.eventsBetween(u.id, "2026-11-12", "2026-11-12")).length, 1, "второй раз копия не появляется");

    assert.equal((await call(`/api/events/${ev}/copy`, { date: "12.11" }, token)).status, 400);
    assert.equal((await call(`/api/events/${other}/copy`, { date: "2026-11-12" }, token)).status, 404);

    // Перенос: тот же план переезжает на другой день, время остаётся.
    const mv = await call(`/api/events/${ev}`, { date: "2026-11-14" }, token);
    assert.equal(mv.status, 200);
    assert.equal(mv.json.id, ev);
    assert.equal(mv.json.date_iso, "2026-11-14");
    assert.equal(mv.json.time, "14:00");
    assert.equal(mv.json.status, "active");
    assert.equal((await store.eventsBetween(u.id, "2026-11-10", "2026-11-10")).length, 0, "со старого дня ушёл");
    assert.equal((await call(`/api/events/${ev}`, {}, token)).status, 400);
    assert.equal((await call(`/api/events/${other}`, { date: "2026-11-14" }, token)).status, 404);
    assert.equal((await store.event(other))!.date_iso, "2026-11-10");

    // Сдвиг по времени: начало и конец вместе, день не меняется.
    const rt = await call(`/api/events/${ev}`, { time: "15:30", end_time: "15:45" }, token);
    assert.equal(rt.status, 200);
    assert.equal(rt.json.time, "15:30");
    assert.equal(rt.json.end_time, "15:45");
    assert.equal(rt.json.date_iso, "2026-11-14");
    assert.equal((await call(`/api/events/${ev}`, { time: "16:00", end_time: null }, token)).json.end_time, null);
    assert.equal((await call(`/api/events/${ev}`, { time: "25:00" }, token)).status, 400);
    assert.equal((await call(`/api/events/${ev}`, { time: "16:00", end_time: "15:00" }, token)).status, 400);
    assert.equal((await call(`/api/events/${ev}`, { end_time: "17:00" }, token)).status, 400);
    assert.equal((await store.event(ev))!.time, "16:00");
  } finally {
    server.close();
  }
});
