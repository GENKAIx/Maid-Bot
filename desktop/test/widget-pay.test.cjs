// Нужна подписка (24.11.2026, server/src/access.ts): сервер отвечает 402 с текстом горничной и ссылкой на оплату.
// Проверка на маленьком http-сервере, без Electron (как login-stale.test.cjs): 402 — не «вход устарел» (ключ и вход остаются,
// loginStale не ставится), текст — с невидимой меткой U+2063, ссылка — в lastPay, и только https://t.me/….
// Виджет (widget.js): payNeed узнаёт такой ответ, errText метку снимает, очередь убирает записанное сервером (вторая метка U+2064 —
// не записано: голос остаётся в очереди) и даёт кнопку оплаты;
// main открывает счёт сам (pay-open) — только проверенную ссылку.
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");
const src = read("src/main.js"), widget = read("renderer/widget.js"), preload = read("src/preload.js"), quick = read("renderer/quick.js");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)) + to.length);
const code = cut("/** Сервер перенаправил запрос на другой адрес https", 'const LOGIN_STALE = "вход устарел — войдите снова";');

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };

let reply = { status: 402, body: { error: "Пробная неделя закончилась — я сохранила всё, что было.", pay_url: "https://t.me/$abc123", messageId: 5, saved: true } };
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(reply.status).end(JSON.stringify(reply.body));
});

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = { token: "good", server: base };
  const log = [];
  const A = new Function("settings", "token", "tokenEnc", "serverBase", "maidLog", "saveSettings", "app",
    code + "; return { api, stale: () => loginStale, pay: () => lastPay, PAY_MARK, isPayUrl };")(settings, () => settings.token, "", () => new URL(settings.server).origin,
    (...a) => log.push(a.join(" ")), () => {}, { getVersion: () => "0.1.89" });
  const errOf = (p) => p.then(() => null, (e) => e);
  try {
    // 402: ошибка с меткой, статус 402, вход не устарел, ссылка запомнена.
    const e = await errOf(A.api("POST", "/api/input", { text: "купить хлеб" }));
    check(e && e.status === 402, `402: статус ${e?.status}`);
    check(e.message === "\u2063Пробная неделя закончилась — я сохранила всё, что было.", `402: текст «${e.message}»`);
    check(!A.stale(), "402 — не «вход устарел»");
    check(settings.token === "good", "402 не трогает ключ");
    check(A.pay()?.url === "https://t.me/$abc123", `ссылка из 402: ${JSON.stringify(A.pay())}`);
    check(!log.some((l) => l.includes("401")), "в журнале нет «не принял ключ»");

    // Чужая ссылка не запоминается.
    reply = { status: 402, body: { error: "нужна подписка", pay_url: "https://evil.example/" } };
    await errOf(A.api("POST", "/api/input", {}));
    check(A.pay()?.url === null, "чужая ссылка — null");
    for (const u of ["https://t.me/$x", "https://t.me/invoice/abc"]) check(A.isPayUrl(u), `t.me: ${u}`);
    for (const u of ["http://t.me/$x", "https://t.me.evil.com/$x", "https://t.me/", "file:///c:/x", null]) check(!A.isPayUrl(u), `не t.me: ${u}`);

    // 401 после 402 — по-прежнему вход заново; другие ошибки — без метки.
    reply = { status: 401, body: { error: "нужен вход" } };
    const e401 = await errOf(A.api("GET", "/api/today"));
    check(e401.message === "вход устарел — войдите снова" && A.stale(), "401 — вход устарел");
    reply = { status: 429, body: { error: "Не так быстро 🙂" } };
    const e429 = await errOf(A.api("POST", "/api/input", {}));
    check(e429.message === "Не так быстро 🙂" && e429.status === 429, `429 без метки: «${e429.message}»`);
    // Сервер ничего не записал (saved: false — голос до распознавания): вторая метка U+2064.
    reply = { status: 402, body: { error: "Пробная неделя закончилась", pay_url: "https://t.me/$v", saved: false } };
    const eKeep = await errOf(A.api("POST", "/api/voice", {}));
    check(eKeep.message === "\u2063\u2064Пробная неделя закончилась", `402 без записи: «${JSON.stringify(eKeep.message)}»`);
    reply = { status: 429, body: { error: "Много сообщений подряд", saved: false } };
    const eKeep429 = await errOf(A.api("POST", "/api/voice", {}));
    check(eKeep429.message === "\u2064Много сообщений подряд" && eKeep429.status === 429, "429 без записи — метка U+2064");
  } finally {
    server.close();
  }

  // pay-open: ссылка из lastPay (свежая) или с /api/billing/link; открывается только после isPayUrl; окну — "" или текст.
  const open = cut('ipcMain.handle("pay-open"', "\n});");
  check(/if \(!isPayUrl\(url\)\) return [^\n]+\n\s+lastPay = \{ url, at: Date\.now\(\) \};\n\s+await shell\.openExternal\(url\);/.test(open), "pay-open: openExternal только после isPayUrl");
  check(open.includes('api("POST", "/api/billing/link"'), "pay-open: нет ссылки — берёт с сервера");
  check(/openPay: \(\) => ipcRenderer\.invoke\("pay-open"\)/.test(preload), "preload: openPay без адреса от окна");

  // Виджет: payNeed и errText в маленьком контексте.
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${widget.match(/\nconst errText = .*/)[0]}\n${widget.match(/\nconst payNeed = .*/)[0]}\n${widget.match(/\nconst unsaved = .*/)[0]}\nthis.errText = errText; this.payNeed = payNeed; this.unsaved = unsaved;`, ctx);
  const ipcErr = (m) => new Error(`Error invoking remote method 'api': Error: ${m}`);
  check(ctx.payNeed(ipcErr("\u2063Пробная неделя закончилась")) === "Пробная неделя закончилась", "payNeed: текст без метки");
  check(ctx.payNeed(ipcErr("нет связи с сервером")) === null && ctx.payNeed(ipcErr("вход устарел — войдите снова")) === null, "payNeed: не 402 — null");
  check(ctx.errText(ipcErr("\u2063Подписка закончилась")) === "Подписка закончилась", "errText снимает метку (поправка, погода)");
  check(ctx.payNeed(ipcErr("\u2063\u2064Подписка закончилась")) === "Подписка закончилась" && ctx.unsaved(ipcErr("\u2063\u2064x")), "payNeed и unsaved: вторая метка");
  check(!ctx.unsaved(ipcErr("\u2063x")) && ctx.unsaved(ipcErr("\u2064x")) && ctx.errText(ipcErr("\u2064Много")) === "Много", "unsaved: только со второй меткой");

  // Очередь (поведение, не текст исходника): pump в маленьком контексте с заглушками maid.api, say и прочего.
  const pumpSrc = widget.match(/\nasync function pump\(\) \{[^]*?\n\}\n/)[0];
  check(pumpSrc.indexOf("if (offline(e))") < pumpSrc.indexOf("payNeed(e)"), "pump: сначала «нет связи», потом подписка");
  const helpers = ["offline", "errText", "payNeed", "unsaved"].map((x) => widget.match(new RegExp(`\\nconst ${x} = .*`))[0]).join("\n");
  async function runPump(error, items = 1) {
    const box = vm.createContext({ setTimeout, said: [], changed: 0, payButtons: () => [{ text: "⭐ Оформить подписку" }] });
    vm.runInContext(`${helpers}
      let outbox = [], pumping = false, amendFlying = false;
      const maid = { api: async () => { throw ERR; }, changed: () => { changed++; } };
      const say = (text, o) => said.push({ text, o });
      const noop = () => {}; const drawOutbox = noop, saveOutbox = noop, setState = noop, hideBubble = noop, play = noop, react = noop, remember = noop;
      const restState = () => "idle", failedButtons = () => [], clashButtons = () => [], heardMood = () => null;
      ${pumpSrc}
      this.go = async (n) => { for (let i = 0; i < n; i++) outbox.push({ id: "m" + i, path: "/api/voice", body: {}, label: "голос", state: "wait" }); await pump(); await new Promise((r) => setTimeout(r, 20)); return outbox; };`, box);
    box.ERR = error;
    vm.runInContext("ERR = this.ERR", box);
    const left = await box.go(items);
    return { left, said: box.said, changed: box.changed };
  }
  const saved402 = await runPump(ipcErr("\u2063Пробная неделя закончилась"));
  check(saved402.left.length === 0, "pump: 402, текст записан заметкой — из очереди убрано");
  check(saved402.said.at(-1).text === "Пробная неделя закончилась" && saved402.said.at(-1).o.buttons[0].text === "⭐ Оформить подписку", "pump: облачко с кнопкой оплаты");
  check(saved402.changed === 1, "pump: данные перечитаны");
  const voice402 = await runPump(ipcErr("\u2063\u2064Пробная неделя закончилась"));
  check(voice402.left.length === 1 && voice402.left[0].state === "failed", "pump: 402 без записи (голос) — осталось в очереди «не отправлено»");
  check(/осталось в очереди/.test(voice402.said.at(-1).text) && voice402.said.at(-1).o.buttons.length === 1, "pump: голос — сказано, что сообщение ждёт, и кнопка оплаты");
  const voice429 = await runPump(ipcErr("\u2064Много сообщений подряд"));
  check(voice429.left.length === 1 && voice429.left[0].state === "failed", "pump: 429 без записи — тоже в очереди");
  const other = await runPump(ipcErr("сервер 500"));
  check(other.left.length === 0 && other.said.at(-1).text === "сервер 500", "pump: прочие ошибки — как раньше");
  const btns = widget.match(/\nfunction payButtons\(\) \{[^]*?\n\}\n/)[0];
  check(btns.includes("maid.openPay()") && !/https?:/.test(btns), "кнопка: открывает main, адреса в окне нет");

  // Быстрая запись: та же метка — текст и кнопка оплаты.
  check(/if \(msg\.startsWith\("\\u2063"\)\) \{[^]*maid\.openPay\(\)/.test(quick), "быстрая запись: кнопка оплаты на 402");

  console.log(bad ? `widget-pay: ${bad} из ${n} не прошли` : `widget-pay: ${n} из ${n}`);
  process.exit(bad ? 1 : 0);
});
