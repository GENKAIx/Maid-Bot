// Испорченный ключ программы (main.js: token, keyOk) — без Electron: ключ не латиницей (до 0.1.30 в поле «Ключ» вписывали
// что угодно) — не вход: стирается, программа просит войти заново (loginStale), запись в журнале; ключ сервера проходит.
const fs = require("fs");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "../src/main.js"), "utf8");
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const code = cut("function token()", "// Журнал программы");

let bad = 0, n = 0;
const check = (ok, m) => { n++; if (!ok) { bad++; console.log("FAIL", m); } };
const make = (tok, enc = "") => {
  const st = { saved: 0, log: [] };
  const settings = { token: tok };
  const box = new Function(
    "settings", "safeStorage", "maidLog", "saveSettings", "enc",
    "let tokenEnc = enc, tokenFailed = false, loginStale = false;" + code + "; return { token, get stale() { return loginStale; } };",
  )(settings, { decryptString: (b) => b.toString("utf8") }, (...a) => st.log.push(a.join(" ")), () => st.saved++, enc);
  return { box, st, settings };
};

try {
  const good = make("AbC-d_e09xyz");
  check(good.box.token() === "AbC-d_e09xyz" && !good.box.stale && good.st.saved === 0, "ключ сервера не прошёл");
  const ru = make("мойпароль123");
  check(ru.box.token() === "" && ru.box.stale && ru.settings.token === "" && ru.st.saved === 1, "русский ключ остался входом");
  check(ru.st.log.some((l) => l.includes("ключ программы испорчен")) && !ru.st.log.some((l) => l.includes("мойпароль")), "журнал: нет записи или в нём ключ");
  check(make("abc def").box.token() === "", "ключ с пробелом остался входом");
  const enc = make("", Buffer.from("ключ", "utf8").toString("base64"));
  check(enc.box.token() === "" && enc.box.stale, "зашифрованный испорченный ключ остался входом");
  const encOk = make("", Buffer.from("tok-ok", "utf8").toString("base64"));
  check(encOk.box.token() === "tok-ok" && !encOk.box.stale, "зашифрованный ключ сервера не прошёл");
  check(make("").box.token() === "" && !make("").box.stale, "без ключа: признак выставлен зря");
} catch (e) {
  check(false, `тест оборвался: ${e?.stack ?? e}`);
}
console.log(`${n - bad}/${n}`);
process.exit(bad ? 1 : 0);
