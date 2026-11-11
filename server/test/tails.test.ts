import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { Pipeline } from "../src/pipeline.ts";

// Разбор хвостов в виджете ПК: просроченную задачу отметить сделанной, закрыть невыполненной или перенести на день.

test("хвосты: «не сделано» закрывает задачу, перенос меняет срок, чужую не трогает", async () => {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const add = (title: string, user_id = u.id) =>
    store.addTask({ user_id, title, priority: "normal", category: "", due_date: "2026-11-08", notes: "", message_id: null });
  const failed = await add("Позвонить в банк");
  const moved = await add("Купить лампочку");
  const dodged = await add("Разобрать почту");
  const other = await add("Чужая", (await store.ensureUser("200", "Чужой", "Europe/Moscow")).id);

  const pipe = new Pipeline(store, async () => "{}");
  let changed = 0;
  pipe.onChange = () => changed++;
  const server = createApi({ store, pipeline: pipe }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as { status?: string; due_date?: string } };
  };
  try {
    const { json } = await call("/api/login", { login: "owner", password: "secret-pass-1", label: "test" });
    const token = (json as { token: string }).token;

    const f = await call(`/api/tasks/${failed}`, { status: "failed" }, token);
    assert.equal(f.json.status, "failed");
    assert.ok(!(await store.openTasks(u.id)).some((t) => t.id === failed), "невыполненная ушла из открытых");

    const d = await call(`/api/tasks/${dodged}`, { status: "dodged" }, token);
    assert.equal(d.json.status, "dodged");
    assert.ok(!(await store.openTasks(u.id)).some((t) => t.id === dodged), "«сбежал» тоже закрывает задачу");

    const m = await call(`/api/tasks/${moved}`, { due_date: "2026-11-12" }, token);
    assert.equal(m.json.due_date, "2026-11-12");
    assert.equal(m.json.status, "open");

    // Удалить задачу (× или ПКМ в виджете) — уходит из открытых.
    const del = await call(`/api/tasks/${moved}`, { status: "deleted" }, token);
    assert.equal(del.json.status, "deleted");
    assert.ok(!(await store.openTasks(u.id)).some((t) => t.id === moved), "удалённая ушла из открытых");

    // Задача → план (ПКМ → «Задать время» / «Повторять…»): план на её день, задача закрыта как planned.
    const planned = await add("Записаться к врачу");
    const pl = await call(`/api/tasks/${planned}/plan`, {}, token);
    const plan = pl.json as { id: number; title: string; date_iso: string; time: string | null };
    assert.equal(pl.status, 200);
    assert.equal(plan.title, "Записаться к врачу");
    assert.equal(plan.date_iso, "2026-11-08");
    assert.equal(plan.time, null);
    assert.equal((await store.task(planned))!.status, "planned");
    assert.ok(!(await store.openTasks(u.id)).some((t) => t.id === planned), "ставшая планом ушла из задач");
    assert.equal((await call(`/api/tasks/${planned}/plan`, {}, token)).status, 409, "второй раз не превращается");

    // Копия задачи на другой день; повтор на тот же день не плодит дубль.
    const keep = await add("Полить цветы");
    const cp = await call(`/api/tasks/${keep}/copy`, { date: "2026-11-09" }, token);
    const copy = cp.json as { id: number; due_date: string; status: string };
    assert.equal(copy.due_date, "2026-11-09");
    assert.equal(copy.status, "open");
    assert.notEqual(copy.id, keep);
    assert.equal((await store.task(keep))!.status, "open", "исходная остаётся");
    const again = await call(`/api/tasks/${keep}/copy`, { date: "2026-11-09" }, token);
    assert.equal((again.json as { id: number; duplicate?: boolean }).duplicate, true);
    assert.equal((again.json as { id: number }).id, copy.id);
    assert.equal((await call(`/api/tasks/${other}/copy`, { date: "2026-11-09" }, token)).status, 404);

    // Быстрый ввод на «Сегодня»: задача с названием как есть; «Отменить» её убирает; пустое название — 400.
    const nt = await call("/api/tasks", { title: "  Купить хлеб ", due_date: "2026-11-09" }, token);
    const made = nt.json as unknown as { id: number; title: string; due_date: string; status: string; undo: number };
    assert.equal(made.title, "Купить хлеб");
    assert.equal(made.due_date, "2026-11-09");
    assert.ok((await store.openTasks(u.id)).some((t) => t.id === made.id));
    await call("/api/undo", { messageId: made.undo }, token);
    assert.ok(!(await store.openTasks(u.id)).some((t) => t.id === made.id), "отмена убрала новую задачу");
    assert.equal((await call("/api/tasks", { title: "  " }, token)).status, 400);

    assert.equal((await call(`/api/tasks/${moved}`, { due_date: "12.11" }, token)).status, 400);
    assert.equal((await call(`/api/tasks/${moved}`, {}, token)).status, 400);
    assert.equal((await call(`/api/tasks/${other}`, { status: "failed" }, token)).status, 404);
    assert.equal((await store.task(other))!.status, "open");
    assert.equal(changed, 8, "список-виджет в Telegram обновится после каждого изменения");
  } finally {
    server.close();
  }
});
