// Счётчики фич на стенде (harness.cjs): настоящий main.js против поддельного сервера. Запуск — с виджета: widget.start;
// имена от виджета берутся, от других окон и чужие — нет; пачка уходит при выходе с заголовком клиента widget, выход ждёт её;
// старый сервер (404) и нет связи — ни ошибок окнам, ни лишних запросов: выход не задерживается, остаток ждёт в файле.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { boot, loggedIn } = require("./harness.cjs");
const fake = require("./fake-server.cjs");

async function rig(t, opts = {}) {
  const srv = await fake.create().listen();
  const h = boot({ settings: loggedIn(srv.url), ...opts });
  await h.ready();
  t.after(async () => { h.stop(); await srv.close(); });
  return { srv, h };
}
/** Выход как в Electron: before-quit (его могут отложить), потом — когда app.quit позвали снова. */
async function quit(h) {
  h.app.quitCalled = false;
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  h.app.emit("before-quit", e);
  if (e.prevented) for (let i = 0; i < 200 && !h.app.quitCalled; i++) await h.wait(50);
  return e;
}

test("пачка при выходе: запуск, имена от виджета, клиент widget", async (t) => {
  const { srv, h } = await rig(t);
  h.send("usage", ["widget.fold"]);
  h.send("usage", ["widget.fold"]);
  h.send("usage", ["voice"]); // сервер считает сам — не берётся
  h.send("usage", ["widget.poke"], null); // не из виджета — не берётся
  h.send("open-main", []); // главное окно из виджета
  const e = await quit(h);
  assert.equal(e.prevented, true, "выход ждёт пачку");
  assert.equal(h.app.quitCalled, true, "и выходит после неё");
  assert.equal(srv.usage?.length, 1);
  assert.deepEqual(srv.usage[0], { counts: { "widget.start": 1, "widget.fold": 2, "widget.main": 1 }, client: "widget" });
  assert.equal(srv.log.find((r) => r.path === "/api/events/usage").auth, "Bearer good-key");
  // Второй выход — уже не ждёт.
  assert.equal((await quit(h)).prevented, false);
});

test("старый сервер (404): молча, пачка выброшена, файла нет", async (t) => {
  const { srv, h } = await rig(t);
  srv.usageStatus = 404;
  h.send("usage", ["widget.tour"]);
  await quit(h);
  assert.equal(srv.usage.length, 1);
  assert.equal(h.peek("loginStale"), false);
  assert.equal(fs.existsSync(path.join(h.dir, "usage.json")), false);
});

test("нет связи: выход не дольше нескольких секунд, остаток — в файл, со следующего запуска уходит", async (t) => {
  const { srv, h } = await rig(t, { keep: true });
  await srv.close();
  h.send("usage", ["widget.hints"]);
  const t0 = Date.now();
  await quit(h);
  assert.ok(Date.now() - t0 < 7000, "выход не ждёт все повторы");
  h.app.emit("will-quit");
  const file = path.join(h.dir, "usage.json");
  assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).counts["widget.hints"], 1);
  // Следующий запуск на той же папке: остаток взят, файл удалён, при выходе всё уходит одной пачкой.
  const srv2 = await fake.create().listen();
  const userData = path.dirname(h.dir);
  const h2 = boot({ settings: loggedIn(srv2.url), userData });
  await h2.ready();
  t.after(async () => { h2.stop(); await srv2.close(); fs.rmSync(userData, { recursive: true, force: true }); });
  assert.equal(fs.existsSync(file), false);
  await quit(h2);
  assert.deepEqual(srv2.usage[0].counts, { "widget.start": 2, "widget.hints": 1 });
});

test("нет входа: запроса нет, счёт ждёт в файле", async (t) => {
  const srv = await fake.create().listen();
  const h = boot({ settings: { server: srv.url, tracker: { enabled: false, iconsVer: 2 }, widget: { show: true } } });
  await h.ready();
  t.after(async () => { h.stop(); await srv.close(); });
  h.send("usage", ["widget.fold"]);
  await quit(h);
  assert.equal(srv.usage, undefined);
  assert.equal(fs.existsSync(path.join(h.dir, "usage.json")), true);
});
