// Опыт и уровень в шапке виджета: тонкая полоса под часами, «ур. N» — на её правом конце.
// Числа — с сервера (/api/today, поле xp; формула — server/src/profile.ts xpOf). Галочка в виджете сразу пускает искру «+10 ✦»
// в полосу, не дожидаясь опроса; сервер потом только подтверждает. Настройка «Опыт и уровень в шапке» (cfg.xpBar):
// «always» — полоса видна всегда, приглушённо; «event» — появляется на несколько секунд после прибавки (и при наведении на шапку).

// Сколько даёт галочка — как XP на сервере (server/src/profile.ts): задача 10, привычка 5.
const XP_GAIN = { task: 10, habit: 5 };
const XP_SHOW_MS = 4000; // «по событию»: сколько полоса видна после прибавки
const XP_COMBO_MS = 1600; // галочки чаще этого — одна серия: одно растущее «+N» и один звон в конце
const XP_HOLD_MS = 12000; // после галочки опрос не трогает полосу, пока отметка не дошла до сервера (и пока ждут строки «улетают»)
const XP_FILL_MS = 600; // как transition ширины у .xp-bar b
let xpShown = null; // что сейчас нарисовано: { xp, level, into, need }
let xpDrawnLevel = 0; // уровень, под который сейчас нарисована полоса
let xpFillTimer = 0;
let xpHoldUntil = 0; // до этого времени опрос не трогает показанное (галочка ещё едет на сервер)
let xpShowTimer = 0;
let xpCombo = null; // серия галочек: { sum, timer }
let xpPlusSum = 0; // сколько долетело в эту серию: метка уровня показывает «+N ✦» вместо «ур. N»
let xpPlusLevel = 0; // уровень до серии: вырос — после серии метка подпрыгнет
let xpPlusTimer = 0;
let xpAirSum = 0; // сколько опыта сейчас летит искрами
let xpVoid = 0; // сколько из летящих уже отменили (сняли галочку на лету) — такие садятся молча

// Уровень по опыту — копия levelOf из server/src/profile.ts.
function xpLevel(xp) {
  let level = 1;
  let left = xp;
  while (left >= 100 + 25 * (level - 1)) {
    left -= 100 + 25 * (level - 1);
    level++;
  }
  return { xp, level, into: left, need: 100 + 25 * (level - 1) };
}

// Нарисовать полосу и уровень. Новый уровень — полоса сначала дозаполняется до конца, потом начинается заново (не «отъезжает» назад).
function xpDraw() {
  const head = $("#head");
  const fill = $("#xpFill");
  if (!head || !fill) return;
  head.classList.toggle("has-xp", Boolean(xpShown));
  if (!xpShown) return;
  if (!xpPlusSum) $("#xpLvl").textContent = `ур. ${xpShown.level}`;
  const width = `${Math.min(100, Math.round((xpShown.into / xpShown.need) * 1000) / 10)}%`;
  clearTimeout(xpFillTimer);
  const snap = (w) => { fill.style.transition = "none"; fill.style.width = w; void fill.offsetWidth; fill.style.transition = ""; };
  if (xpDrawnLevel && xpShown.level > xpDrawnLevel) {
    fill.style.width = "100%";
    xpFillTimer = setTimeout(() => { snap("0%"); fill.style.width = width; }, XP_FILL_MS + 50);
  } else if (xpShown.level < xpDrawnLevel) snap(width);
  else fill.style.width = width;
  xpDrawnLevel = xpShown.level;
  $("#xpLvl").title = $("#xpBar").title = `Опыт: ${xpShown.into} из ${xpShown.need} до ${xpShown.level + 1} ур. · всего ${xpShown.xp}\nЗадача — 10, привычка — 5, день с записью в дневнике — 3`;
}

// Ждёт ли что-то отправки: строки режима «улетают», ещё не ушедшие на сервер (у них нет срока: курсор на строке держит её сколько угодно).
function xpWaiting() {
  return Date.now() < xpHoldUntil || [...leavingRows.values()].some((x) => !x.sent);
}

// Опрос /api/today (widget.js load): сверить с сервером. Пока отметка из виджета едет — не трогать (опрос может быть старым).
function xpSync(x) {
  if (!x || !Number.isFinite(x.xp)) return;
  if (!xpShown) { xpShown = xpLevel(x.xp); return xpDraw(); }
  if (x.xp === xpShown.xp || xpWaiting()) return;
  const diff = x.xp - xpShown.xp;
  if (diff > 0 && !xpPlusSum) xpPlusLevel = xpShown.level;
  xpShown = xpLevel(x.xp);
  xpDraw();
  // Прибавилось без искры (Telegram, телефон, сайт, кнопки облачка, меню привычки) — «+N ✦» в метке и полоса на виду, без звона.
  if (diff > 0) { xpPlus(diff); xpPeek(); }
}

// Отметка уходит на сервер (режим «улетают» — через несколько секунд после галочки): держать полосу, пока не ответит.
function xpHold() {
  xpHoldUntil = Math.max(xpHoldUntil, Date.now() + XP_HOLD_MS);
}

// Отметка ушла на сервер (или вернулась ошибкой) — дать опросу верить серверу, как только ответит тот, что начался после неё.
function xpSent() {
  xpHoldUntil = Math.min(xpHoldUntil, Date.now() + 2500);
}

// Галочка в виджете: искра от галочки (from — её элемент или null) в полосу, полоса подрастает.
function xpGain(from, kind) {
  const n = XP_GAIN[kind];
  if (!n || !xpShown) return;
  xpHoldUntil = Date.now() + XP_HOLD_MS;
  if (!xpPlusSum && !xpCombo) xpPlusLevel = xpShown.level;
  xpShown = xpLevel(xpShown.xp + n);
  const first = !xpCombo;
  if (first) xpCombo = { sum: 0, timer: 0 };
  xpCombo.sum += n;
  clearTimeout(xpCombo.timer);
  xpCombo.timer = setTimeout(xpComboEnd, XP_COMBO_MS);
  xpPeek();
  const land = (flew) => {
    if (flew) xpAirSum -= n;
    xpDraw();
    if (xpVoid >= n) { xpVoid -= n; return; } // галочку сняли, пока искра летела
    xpPlus(n);
    const bar = $("#xpBar");
    bar?.classList.remove("glow");
    void bar?.offsetWidth;
    bar?.classList.add("glow");
  };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!from || still || !from.isConnected || !xpFly(from, first ? `+${n} ✦` : "✦", () => land(true))) return land(false);
  xpAirSum += n;
}

// Галочку сняли или отменили улёт — убрать прибавку тихо (сервер тоже считает по отметкам). Если её искра ещё летит — сядет молча;
// если уже в метке («+N ✦») — число в метке уменьшается.
function xpTake(kind) {
  const n = XP_GAIN[kind];
  if (!n || !xpShown) return;
  xpHoldUntil = Date.now() + XP_HOLD_MS;
  xpShown = xpLevel(Math.max(0, xpShown.xp - n));
  if (xpCombo) xpCombo.sum -= n;
  if (xpAirSum - xpVoid >= n) xpVoid += n;
  else if (xpPlusSum) {
    xpPlusSum -= n;
    if (xpPlusSum > 0) $("#xpLvl").textContent = `+${xpPlusSum} ✦`;
    else xpPlusEnd();
  }
  xpDraw();
}

// Отметка не прошла — вернуть её прибавку (или снятие) назад без искры; остальные отметки в пути не трогаем.
function xpUndo(kind, sign = -1) {
  const n = XP_GAIN[kind];
  if (!n || !xpShown) return;
  xpShown = xpLevel(Math.max(0, xpShown.xp + sign * n));
  xpDraw();
  xpSent();
}

// Искра летит дугой от галочки к концу заполненной части полосы; false — не полетела (панель свёрнута, полосы не видно).
function xpFly(from, text, done) {
  const bar = $("#xpBar");
  const b = bar?.getBoundingClientRect();
  if (!b || !b.width || !bar.offsetParent) return false;
  const a = from.getBoundingClientRect();
  const x0 = a.left + a.width / 2;
  const y0 = a.top + a.height / 2;
  const x1 = b.left + Math.max(6, (b.width * xpShown.into) / xpShown.need);
  const y1 = b.top + b.height / 2;
  const s = document.createElement("i");
  s.className = text.length > 1 ? "xp-fly" : "xp-fly dot";
  s.textContent = text;
  Object.assign(s.style, { left: `${x0}px`, top: `${y0}px`, opacity: "0" }); // вне анимации не видна: не мелькает на месте галочки
  document.body.append(s);
  const lift = Math.min(70, 26 + Math.abs(y0 - y1) * 0.25);
  const mx = (x1 - x0) * 0.35;
  const my = Math.min(y0, y1) - y0 - lift;
  const anim = s.animate([
    { transform: "translate(-50%, -50%) scale(.6)", opacity: 0 },
    { transform: "translate(-50%, -50%) scale(1.05)", opacity: 1, offset: 0.18 },
    { transform: `translate(calc(-50% + ${mx}px), calc(-50% + ${my}px)) scale(1)`, opacity: 1, offset: 0.55 },
    { transform: `translate(calc(-50% + ${x1 - x0}px), calc(-50% + ${y1 - y0}px)) scale(.35)`, opacity: 0.2 },
  ], { duration: 720, easing: "cubic-bezier(.45, 0, .55, 1)", fill: "forwards" });
  anim.onfinish = anim.oncancel = () => { s.remove(); done(); };
  return true;
}

// Метка уровня на время серии показывает «+N ✦» (в серии растёт одно число), потом снова «ур. N»; вырос уровень — подпрыгивает.
function xpPlus(n) {
  const l = $("#xpLvl");
  if (!l) return;
  xpPlusSum += n;
  l.textContent = `+${xpPlusSum} ✦`;
  l.classList.add("gain");
  clearTimeout(xpPlusTimer);
  xpPlusTimer = setTimeout(xpPlusEnd, XP_COMBO_MS);
}
function xpPlusEnd() {
  clearTimeout(xpPlusTimer);
  xpPlusSum = 0;
  $("#xpLvl")?.classList.remove("gain");
  xpDraw();
  if (xpShown && xpShown.level > xpPlusLevel) xpLevelUp();
  xpPlusLevel = xpShown?.level ?? 0;
}

// Серия кончилась: один тихий звон (если звуки включены и прибавка не отменена целиком).
function xpComboEnd() {
  const sum = xpCombo?.sum ?? 0;
  xpCombo = null;
  if (sum > 0) xpChime();
}
function xpChime() {
  if (cfg.mute) return;
  try {
    actx ??= new AudioContext(); // общий с popTone (course.js)
    const t = actx.currentTime + 0.01;
    [1568, 2093].forEach((f, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.07, t + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + 0.5);
      o.connect(g).connect(actx.destination);
      o.start(t + i * 0.07);
      o.stop(t + i * 0.07 + 0.55);
    });
  } catch {}
}

// Новый уровень: метка подпрыгивает и светится. Церемония — отдельной задачей (ревью 20.11, «Поклон»).
function xpLevelUp() {
  const l = $("#xpLvl");
  if (!l) return;
  l.classList.remove("up");
  void l.offsetWidth;
  l.classList.add("up");
  xpPeek(XP_SHOW_MS * 2);
}

// «По событию»: показать полосу на время. В режиме «всегда» — просто ярче на это время.
function xpPeek(ms = XP_SHOW_MS) {
  const w = $("#w");
  if (!w) return;
  w.classList.add("xp-show");
  clearTimeout(xpShowTimer);
  xpShowTimer = setTimeout(() => w.classList.remove("xp-show"), ms);
}

// Настройка из cfg (widget.js applyCfg).
function xpApplyCfg() {
  $("#w")?.classList.toggle("xp-event", cfg.xpBar === "event");
}
