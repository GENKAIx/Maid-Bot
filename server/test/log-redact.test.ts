import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { redactSecrets } from "../src/log-redact.ts";

const TOKEN = "1234567890:AAEmflYaYjjzqWpmRBLQTIad-PmSMquHQ0x";

test("токен бота в адресе запроса скрыт, даже если его нет в списке", () => {
  const out = redactSecrets(`request to https://api.telegram.org/bot${TOKEN}/setWebhook failed`);
  assert.ok(!out.includes(TOKEN));
  assert.match(out, /bot<токен бота>\/setWebhook/);
});

test("ключи из списка скрыты, короткие строки не трогаются", () => {
  const out = redactSecrets("key=sk-or-v1-abcdef123456 port=3000", ["sk-or-v1-abcdef123456", "3000", ""]);
  assert.equal(out, "key=<скрыто> port=3000");
});

test("console.error и падение процесса печатают без секретов", () => {
  const code = `
    import { installLogRedaction } from "./src/log-redact.ts";
    installLogRedaction(["super-secret-key-42"]);
    console.error("ошибка", new Error("fetch https://api.telegram.org/bot${TOKEN}/getMe failed"), "super-secret-key-42");
    Promise.reject(new Error("upal bot${TOKEN}"));
  `;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", cwd: new URL("..", import.meta.url) });
  const all = r.stdout + r.stderr;
  assert.equal(r.status, 1, all);
  assert.ok(!all.includes(TOKEN), all);
  assert.ok(!all.includes("super-secret-key-42"), all);
  assert.match(all, /<токен бота>/);
  assert.match(all, /\[fatal\]/);
});
