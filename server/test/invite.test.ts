import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { todayJson } from "../src/api.ts";
import { verifyPassword } from "../src/auth.ts";
import { Store } from "../src/db.ts";
import { createInvite, INVITE_DAYS, installerUrl, isMember, redeemInvite } from "../src/invite.ts";

// Приглашения друзей: владелец даёт одноразовую ссылку, друг получает учётную запись с логином и паролем и становится своим для бота.

const TZ = "Europe/Moscow";
const OWNER = "111";
const VASYA = { id: "222", name: "Вася", username: "Vasya_Pupkin" };

test("приглашение: друг получает логин из @username и пароль, который подходит для входа", async () => {
  const store = await Store.open(":memory:");
  const code = await createInvite(store);
  const got = await redeemInvite(store, code, VASYA, TZ);
  assert.ok(got);
  assert.equal(got.login, "vasya_pupkin");
  assert.equal(got.user.chat_id, "222");
  assert.equal(got.user.name, "Вася");
  assert.ok(got.password!.length >= 8);
  assert.ok(await verifyPassword(got.password!, (await store.userByLogin("vasya_pupkin"))!.password_hash));
});

test("приглашение одноразовое; чужой, просроченный код и уже свой чат — не проходят", async () => {
  const store = await Store.open(":memory:");
  const code = await createInvite(store);
  assert.ok(await redeemInvite(store, code, VASYA, TZ));
  assert.equal(await redeemInvite(store, code, { id: "333", name: "Петя" }, TZ), null); // использован
  assert.equal(await redeemInvite(store, "нет-такого-кода", { id: "333", name: "Петя" }, TZ), null);
  const old = await createInvite(store, new Date("2026-11-01T12:00:00Z"));
  assert.equal(await redeemInvite(store, old, { id: "333", name: "Петя" }, TZ, new Date(Date.parse("2026-11-01T12:00:00Z") + (INVITE_DAYS + 1) * 86_400_000)), null);
  // Друг (бесплатно навсегда) — код не тратится, им может воспользоваться другой.
  const fresh = await createInvite(store);
  const vasya = (await store.userByChat("222"))!;
  await store.updateUser(vasya.id, { plan: "friend" });
  const same = await redeemInvite(store, fresh, VASYA, TZ);
  assert.deepEqual([same?.login, same?.until], [null, null]);
  assert.ok((await redeemInvite(store, fresh, { id: "333", name: "Петя" }, TZ))?.login);
});

test("приглашение — подарок на 30 дней: новому проба до подарка, у кого запись есть — срок продлевается от конца прежнего", async () => {
  const store = await Store.open(":memory:");
  const now = new Date("2026-11-24T10:00:00Z");
  const got = (await redeemInvite(store, await createInvite(store, now), VASYA, TZ, now))!;
  assert.equal(got.user.plan, "trial");
  assert.equal(got.until, new Date(now.getTime() + 30 * 86_400_000).toISOString());
  // Второй подарок той же записи: без нового логина, срок +30 дней от конца прежнего.
  const again = (await redeemInvite(store, await createInvite(store, now), VASYA, TZ, now))!;
  assert.equal(again.login, null);
  assert.equal(again.until, new Date(now.getTime() + 60 * 86_400_000).toISOString());
  assert.equal((await store.userByChat("222"))!.access_until, again.until);
});

test("логин: занят — с числом, без @username — friend", async () => {
  const store = await Store.open(":memory:");
  const a = await redeemInvite(store, await createInvite(store), VASYA, TZ);
  const b = await redeemInvite(store, await createInvite(store), { id: "333", name: "Другой Вася", username: "vasya_pupkin" }, TZ);
  const c = await redeemInvite(store, await createInvite(store), { id: "444", name: "Без ника" }, TZ);
  const d = await redeemInvite(store, await createInvite(store), { id: "555", name: "Тоже", username: "Я" }, TZ);
  assert.deepEqual([a?.login, b?.login, c?.login, d?.login], ["vasya_pupkin", "vasya_pupkin2", "friend", "friend2"]);
});

test("свои для бота: владелец и принявший приглашение; чужой — нет", async () => {
  const store = await Store.open(":memory:");
  await redeemInvite(store, await createInvite(store), VASYA, TZ);
  assert.equal(await isMember(store, OWNER, [OWNER]), true);
  assert.equal(await isMember(store, "222", [OWNER]), true);
  assert.equal(await isMember(store, "999", [OWNER]), false);
});

test("друг не видит планов и задач владельца", async () => {
  const store = await Store.open(":memory:");
  const owner = await store.ensureUser(OWNER, "Хозяин", TZ);
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  await store.addEvent({ user_id: owner.id, title: "Тайный план", date_iso: day, time: "23:59", end_time: null, details: "", domain: "", message_id: null });
  const friend = (await redeemInvite(store, await createInvite(store), VASYA, TZ))!.user;
  const mine = await todayJson(store, owner, new Date());
  const his = await todayJson(store, friend, new Date());
  assert.ok(mine.events.some((e) => e.title === "Тайный план"));
  assert.equal(his.events.length, 0);
  assert.equal(his.upcoming.length, 0);
});

test("ссылка на установщик — из latest.yml; нет файла — null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maid-invite-"));
  assert.equal(installerUrl(dir, "https://maid.example"), null);
  fs.writeFileSync(path.join(dir, "latest.yml"), "version: 0.1.28\nfiles:\n  - url: Gornichnaya-Setup-0.1.28.exe\npath: Gornichnaya-Setup-0.1.28.exe\n");
  assert.equal(installerUrl(dir, "https://maid.example"), "https://maid.example/desktop/Gornichnaya-Setup-0.1.28.exe");
  assert.equal(installerUrl(dir, ""), null);
});
