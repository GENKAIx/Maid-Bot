// Выключенный микрофон (voice.js: isHush, stop; widget.js: micCheck, toggleMic) без Electron и браузера.
// 18.11.2026: голосовое с выключенным на наушниках микрофоном уходило на сервер, и только оттуда приходило «ничего не
// услышала». Теперь: 5 с записи с ровной волной — Рина предупреждает сразу (запись идёт дальше, одно предупреждение
// на запись); вся запись — тишина — на сервер не уходит, она сразу говорит «проверьте микрофон».
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const dir = path.join(__dirname, "..", "renderer");
const widget = fs.readFileSync(path.join(dir, "widget.js"), "utf8");
const voice = fs.readFileSync(path.join(dir, "voice.js"), "utf8");
const fn = (name) => widget.match(new RegExp(`\\n(async )?function ${name}\\([^]*?\\n\\}\\r?\\n`))?.[0] ?? "";
const line = (start) => widget.match(new RegExp(`\\n(${start}[^\\n]*)`))?.[1] ?? "";
for (const f of ["micCheck", "toggleMic"]) check(fn(f), `в widget.js нет ${f}`);
check(line("const MIC_HINT"), "в widget.js нет MIC_HINT");
check(/micCheck\(\)/.test(fn("micUi")), "micUi: во время записи не зовётся micCheck");

(async () => {
  try {
    // 1. Что считать тишиной: выключенный микрофон — ноль или почти ноль; тихая комната и речь — нет.
    const vctx = { window: {}, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval };
    vm.createContext(vctx);
    vm.runInContext(`${voice}\nthis.Voice = Voice;`, vctx);
    const { isHush } = vctx.Voice;
    check(typeof isHush === "function", "в Voice нет isHush");
    const many = (v, k = 70) => Array(k).fill(v);
    check(isHush(many(0)), "ровный ноль — тишина");
    check(isHush(many(0.05)), "почти ноль (шум выключенного микрофона) — тишина");
    check(!isHush([...many(0.05), 0.5]), "хоть одно слово — не тишина");
    check(!isHush(many(0.3)), "тихая комната (уровень ~0,3) — не тишина");
    check(!isHush(many(0, 5)), "слишком мало замеров — не судить");
    check(!isHush([]), "замеров нет (громкость не меряется) — не судить");

    // 2. Во время записи: 5 с тишины — одно предупреждение.
    const said = [], sent = [];
    let rec = false, secs = 0, hush = true;
    const ctx = {
      $: () => ({ classList: { toggle() {} }, title: "" }),
      chatBox: { classList: { toggle() {} }, querySelector: () => ({}) },
      chatInput: { value: "", focus() {} }, pictures: [], micTick: 0,
      clearInterval() {}, setInterval() { return 0; },
      Voice: {
        get on() { return rec; }, get seconds() { return secs; }, get hushed() { return hush; },
        start: async () => { rec = true; },
        stop: async () => { rec = false; return hush ? { silent: true } : { audio: "AAAA", mime: "audio/webm" }; },
        clock: () => "0:01", wave() {},
      },
      enqueue: (...a) => sent.push(a),
      say: (t, o) => said.push([t, o?.emotion]),
      crypto: { randomUUID: () => "id" },
    };
    vm.createContext(ctx);
    vm.runInContext(`let micWarned = false;\n${line("const MIC_HINT")}\n${fn("syncSend")}\n${fn("micUi")}\n${fn("micCheck")}\n${fn("toggleMic")}
      this.toggleMic = toggleMic; this.micCheck = micCheck;`, ctx);
    await ctx.toggleMic();
    secs = 3; ctx.micCheck();
    check(!said.length, "3 с тишины — ещё рано");
    secs = 5; ctx.micCheck(); ctx.micCheck(); secs = 9; ctx.micCheck();
    check(said.length === 1 && /микрофон/.test(said[0][0]) && said[0][1] === "worried", `5 с тишины — одно предупреждение: ${JSON.stringify(said)}`);
    check(ctx.Voice.on, "предупреждение не останавливает запись");

    // 3. Вся запись — тишина: на сервер не уходит, сразу «проверьте микрофон».
    said.length = 0;
    await ctx.toggleMic();
    check(!sent.length, `тишина не уходит на сервер: ${JSON.stringify(sent)}`);
    check(said.length === 1 && /микрофон/.test(said[0][0]), `тишина — сразу сказать: ${JSON.stringify(said)}`);

    // 4. Новая запись — предупреждение снова возможно; с голосом — не предупреждает и отправляется.
    said.length = 0;
    await ctx.toggleMic();
    secs = 6; ctx.micCheck();
    check(said.length === 1, "новая запись — снова одно предупреждение");
    await ctx.toggleMic(); // остановить тихую запись
    said.length = 0;
    hush = false;
    await ctx.toggleMic();
    secs = 7; ctx.micCheck();
    check(!said.length, `с голосом — молчит: ${JSON.stringify(said)}`);
    await ctx.toggleMic();
    check(sent.length === 1 && sent[0][0] === "/api/voice", `с голосом — отправляется: ${JSON.stringify(sent)}`);
  } catch (e) {
    n++; bad++;
    console.log("FAIL", e.message);
  }
  console.log(`${n - bad}/${n} проверок`);
  if (bad) process.exit(1);
})();
