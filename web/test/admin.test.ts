import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_ACTIONS, ADMIN_SECTIONS, adminSection } from "../src/admin.ts";

// Разделы админки по адресу /admin/<раздел> (web/src/admin.ts).
test("админка: раздел по адресу, незнакомый — Обзор; журнал подписан", () => {
  assert.equal(adminSection(undefined), "overview");
  assert.equal(adminSection("log"), "log");
  assert.equal(adminSection("nope"), "overview");
  assert.equal(new Set(ADMIN_SECTIONS.map((s) => s.id)).size, ADMIN_SECTIONS.length);
  for (const a of ["code", "enter", "wrong", "leave"]) assert.ok(ADMIN_ACTIONS[a], a);
});
