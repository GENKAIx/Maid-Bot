import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApi } from "../src/api.ts";
import { hashPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import type { LlmCall } from "../src/llm.ts";
import { Pipeline } from "../src/pipeline.ts";

// Уточняющий вопрос на сайте (28.11.2026, docs/ДИЗАЙН.md 5.8): ответ несёт признак clarify, вопрос можно закрыть крестиком
// (POST /api/messages/:id/dismiss) или оставить фразу заметкой — после этого следующая фраза не приклеивается к старой.

async function setup(answers: (unknown | Error)[]) {
  const store = await Store.open(":memory:");
  const u = await store.ensureUser("100", "Тест", "Europe/Moscow");
  await store.updateUser(u.id, { login: "owner", password_hash: await hashPassword("secret-pass-1") });
  const seen: string[] = [];
  const llm: LlmCall = async (m) => {
    seen.push(m.at(-1)?.content ?? "");
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return JSON.stringify(a ?? {});
  };
  const pipe = new Pipeline(store, llm);
  const server = createApi({ store, pipeline: pipe }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  const { token } = (await post("/api/login", { login: "owner", password: "secret-pass-1" })).json;
  const close = async () => { server.close(); await store.close(); };
  return { store, u, seen, pipe, post, token: token as string, close };
}

test("вопрос приходит с признаком clarify; закрытый крестиком больше не ждёт ответа", async () => {
  const t = await setup([
    { clarify: "В 7 утра или вечера?" },
    { tasks: [{ title: "Купить хлеб" }], summary: "s" },
  ]);
  try {
    const q = await t.post("/api/input", { text: "завтра в 7 тренировка", id: "a1" }, t.token);
    assert.equal(q.status, 200, JSON.stringify(q.json));
    assert.equal(q.json.clarify, true);
    assert.equal(q.json.undoable, false);
    assert.match(q.json.text, /утра или вечера/);
    assert.equal((await t.store.pendingClarify(t.u.id))?.id, q.json.messageId);

    // Без входа и чужой номер — вопрос остаётся.
    assert.equal((await t.post(`/api/messages/${q.json.messageId}/dismiss`, {})).status, 401);
    const other = await t.store.ensureUser("200", "Другой", "Europe/Moscow");
    assert.deepEqual(await t.pipe.dismissClarify(other, q.json.messageId), { text: "Не нашла этот вопрос.", closed: false });
    assert.equal((await t.store.pendingClarify(t.u.id))?.id, q.json.messageId);

    const d = await t.post(`/api/messages/${q.json.messageId}/dismiss`, {}, t.token);
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.closed, true);
    assert.match(d.json.text, /не записала/);
    assert.equal(await t.store.pendingClarify(t.u.id), undefined);
    assert.equal((await t.store.message(q.json.messageId))!.state, "done");
    // Второй раз — закрывать уже нечего.
    assert.equal((await t.post(`/api/messages/${q.json.messageId}/dismiss`, {}, t.token)).json.closed, false);

    // Следующая фраза разбирается сама по себе, а не как «уточнение» к закрытой.
    const next = await t.post("/api/input", { text: "купить хлеб", id: "a2" }, t.token);
    assert.equal(next.status, 200);
    assert.equal(next.json.clarify, undefined);
    assert.equal(t.seen.at(-1), "купить хлеб");
    assert.equal((await t.store.openTasks(t.u.id)).length, 1);
    assert.equal((await t.store.eventsBetween(t.u.id, "2000-01-01", "2100-01-01")).length, 0);
  } finally {
    await t.close();
  }
});

test("повтор того же id, пока вопрос ждёт: тот же вопрос, а не ответ на самого себя", async () => {
  const t = await setup([{ clarify: "В 7 утра или вечера?" }]);
  try {
    const q = await t.post("/api/input", { text: "завтра в 7 тренировка", id: "b1" }, t.token);
    const again = await t.post("/api/input", { text: "завтра в 7 тренировка", id: "b1" }, t.token);
    assert.equal(again.status, 200);
    assert.deepEqual([again.json.clarify, again.json.duplicate, again.json.messageId, again.json.text], [true, true, q.json.messageId, q.json.text]);
    assert.equal(t.seen.length, 1, "модель второй раз не звали");
    assert.equal((await t.store.pendingClarify(t.u.id))?.id, q.json.messageId);
  } finally {
    await t.close();
  }
});

test("«Оставить заметкой» у вопроса: фраза в заметках, вопрос закрыт", async () => {
  const t = await setup([{ clarify: "В 7 утра или вечера?" }, { tasks: [{ title: "Купить хлеб" }], summary: "s" }]);
  try {
    const q = await t.post("/api/input", { text: "завтра в 7 тренировка", id: "c1" }, t.token);
    const n = await t.post(`/api/messages/${q.json.messageId}/note`, {}, t.token);
    assert.equal(n.status, 200);
    assert.match(n.json.text, /заметки/);
    assert.equal(await t.store.pendingClarify(t.u.id), undefined);
    const msg = (await t.store.message(q.json.messageId))!;
    assert.equal(msg.state, "done");
    assert.ok((await t.store.diaryOf(t.u.id, msg.day_key)).some((d) => d.section === "notes" && d.text === "завтра в 7 тренировка"));
    await t.post("/api/input", { text: "купить хлеб", id: "c2" }, t.token);
    assert.equal(t.seen.at(-1), "купить хлеб");
  } finally {
    await t.close();
  }
});

test("сбой разбора: failed в ответе, «Повторить» с тем же id не создаёт второе сообщение", async () => {
  const t = await setup([new Error("модель молчит"), { tasks: [{ title: "Купить хлеб" }], summary: "s" }]);
  try {
    const bad = await t.post("/api/input", { text: "купить хлеб", id: "d1" }, t.token);
    assert.equal(bad.status, 200);
    assert.deepEqual([bad.json.failed, bad.json.undoable], [true, false]);
    // Сайт шлёт ту же фразу с прежним id (web/src/composer.ts draftFor) — это повтор разбора, а не новая запись.
    const ok = await t.post("/api/input", { text: "купить хлеб", id: "d1" }, t.token);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.failed, undefined);
    assert.equal(ok.json.messageId, bad.json.messageId);
    assert.equal((await t.store.openTasks(t.u.id)).length, 1);
    // И ещё раз тот же id (ответ не дошёл): прежний ответ, второй задачи нет.
    const dup = await t.post("/api/input", { text: "купить хлеб", id: "d1" }, t.token);
    assert.equal(dup.json.duplicate, true);
    assert.equal((await t.store.openTasks(t.u.id)).length, 1);
  } finally {
    await t.close();
  }
});

// Вопрос ждёт, а пришло то, что ответом не считается, или разбор ответа упал: ответ несёт waiting — номер ждущего вопроса,
// сайт по нему оставляет вопрос на экране (web/src/replyview.ts stillAsked).
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("вопрос ждёт: «какая погода?» и картинка его не закрывают, ответ несёт waiting; ответ на вопрос его снимает", async () => {
  const t = await setup([
    { clarify: "В 7 утра или вечера?" },
    { diary: [{ section: "notes", text: "чек" }], summary: "s" },
    { events: [{ title: "Тренировка", date: "2026-11-29", time: "19:00" }], summary: "s" },
  ]);
  try {
    const q = await t.post("/api/input", { text: "завтра в 7 тренировка", id: "e1" }, t.token);
    assert.equal(q.json.clarify, true);
    assert.equal(q.json.waiting, undefined, "сам вопрос — не «другое сообщение»");

    const w = await t.post("/api/input", { text: "какая погода?", id: "e2" }, t.token);
    assert.equal(w.status, 200, JSON.stringify(w.json));
    assert.equal(w.json.waiting, q.json.messageId);
    assert.equal(t.seen.length, 1, "погода — без модели");
    assert.equal((await t.store.pendingClarify(t.u.id))?.id, q.json.messageId);

    const pic = await t.post("/api/input", { text: "", images: [{ data: PIXEL, mime: "image/png" }], id: "e3" }, t.token);
    assert.equal(pic.status, 200, JSON.stringify(pic.json));
    assert.equal(pic.json.waiting, q.json.messageId);
    assert.doesNotMatch(t.seen.at(-1)!, /уточнение/, "картинка разбирается сама по себе");
    assert.equal((await t.store.pendingClarify(t.u.id))?.id, q.json.messageId);

    const a = await t.post("/api/input", { text: "вечера", id: "e4" }, t.token);
    assert.equal(a.status, 200);
    assert.equal(a.json.waiting, undefined);
    assert.equal(t.seen.at(-1), "завтра в 7 тренировка\n(уточнение: вечера)");
    assert.equal(await t.store.pendingClarify(t.u.id), undefined);
  } finally {
    await t.close();
  }
});

test("разбор ответа на вопрос упал: waiting в ответе; «Оставить заметкой» у ответа закрывает и вопрос", async () => {
  const t = await setup([{ clarify: "В 7 утра или вечера?" }, new Error("модель молчит"), { tasks: [{ title: "Купить хлеб" }], summary: "s" }]);
  try {
    const q = await t.post("/api/input", { text: "завтра в 7 тренировка", id: "f1" }, t.token);
    const bad = await t.post("/api/input", { text: "вечера", id: "f2" }, t.token);
    assert.deepEqual([bad.json.failed, bad.json.waiting], [true, q.json.messageId]);
    assert.notEqual(bad.json.messageId, q.json.messageId);

    const n = await t.post(`/api/messages/${bad.json.messageId}/note`, {}, t.token);
    assert.equal(n.status, 200);
    assert.equal(await t.store.pendingClarify(t.u.id), undefined);
    assert.equal((await t.store.message(q.json.messageId))!.state, "done");
    const msg = (await t.store.message(bad.json.messageId))!;
    assert.equal(msg.state, "done");
    // В заметке — исходная фраза вместе с ответом, а не одно слово «вечера».
    assert.ok((await t.store.diaryOf(t.u.id, msg.day_key)).some((d) => d.section === "notes" && d.text === "завтра в 7 тренировка (вечера)"));

    await t.post("/api/input", { text: "купить хлеб", id: "f3" }, t.token);
    assert.equal(t.seen.at(-1), "купить хлеб");
  } finally {
    await t.close();
  }
});

test("разбор ответа на вопрос упал, вопрос закрыли крестиком: упавший ответ тоже закрыт, фон его не разбирает", async () => {
  const t = await setup([{ clarify: "В 7 утра или вечера?" }, new Error("модель молчит")]);
  try {
    const q = await t.post("/api/input", { text: "завтра в 7 тренировка", id: "g1" }, t.token);
    const bad = await t.post("/api/input", { text: "вечера", id: "g2" }, t.token);
    assert.equal(bad.json.failed, true);
    const d = await t.post(`/api/messages/${q.json.messageId}/dismiss`, {}, t.token);
    assert.equal(d.json.closed, true);
    assert.equal((await t.store.message(bad.json.messageId))!.state, "done");
    const sent: string[] = [];
    await t.pipe.retryFailed(async (_u, text) => void sent.push(text), new Date(Date.now() + 3600_000));
    assert.equal(t.seen.length, 2, "модель больше не звали");
    assert.deepEqual(sent, []);
  } finally {
    await t.close();
  }
});

test("разбор ответа на вопрос упал, вопрос оставили заметкой: упавший ответ тоже закрыт", async () => {
  const t = await setup([{ clarify: "В 7 утра или вечера?" }, new Error("модель молчит")]);
  try {
    const q = await t.post("/api/input", { text: "завтра в 7 тренировка", id: "h1" }, t.token);
    const bad = await t.post("/api/input", { text: "вечера", id: "h2" }, t.token);
    await t.post(`/api/messages/${q.json.messageId}/note`, {}, t.token);
    assert.equal((await t.store.message(bad.json.messageId))!.state, "done");
    assert.equal(await t.store.pendingClarify(t.u.id), undefined);
  } finally {
    await t.close();
  }
});
