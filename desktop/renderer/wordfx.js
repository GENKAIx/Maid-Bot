// Слова с характером (с 20.11.2026): одно-два слова в реплике горничной «оживают» — дрожат, набегают числом, зачёркиваются.
// Пометка в тексте реплики: «Срок — [крик]сегодня[/]!», у правки — новое слово через «=»: «сдадите [правка=никогда]завтра[/]».
// Имена — только из списка ниже (поле ru); чужое слово в скобках остаётся как есть. Пометки стоят в готовых репликах виджета
// (lines.js); ответы сервера их не несут. Разбираются они только в своих репликах: lineItem() ставит перед репликой с пометками
// невидимый знак WORDFX_OWN, и лишь тогда say() в widget.js снимает пометки (wordfxStrip) и оборачивает слова (wordfxHtml) —
// название задачи «[счёт] за свет» или ответ сервера остаются как есть.
// Печать (planType / runType) спрашивает у этого файла темп, «бип» и момент действия. Вид — wordfx.css.
// Записи эффектов и их числа собраны из мастерской docs/review/слова-с-характером-2026-11-20.html (там их можно покрутить).
// type — печать на слове: pre / post — паузы до и после, мс; rate — во сколько раз медленнее буквы; pitch, gain — «бип»;
//   every — «бип» на каждую N-ю букву; climb — на сколько полутонов растёт с буквой; whole — слово появляется целиком;
//   one — фраза из нескольких слов идёт одним куском. P — числа вида (те же, что переменные в wordfx.css).
// setup — разметка до печати; hold — сколько мс печать ждёт после слова сверх post; onIn / onGo — первая буква и конец слова;
// final — конечный вид без печати. c: { P, T, w — первое слово, words, arg, tone, noise, bell, jolt, sparkle, later }.
// Все имена верхнего уровня — с wordfx / WORDFX: скрипты страницы делят одну область имён (renderer-globals.test.cjs).
// Тест: desktop/test/widget-wordfx.test.cjs.
const WORDFX = {
  // Слово мелко дрожит от сдержанной злости.
  shk: {
    ru: "строго",
    type: { pre: 320, rate: 1.7, post: 140, pitch: 0.74, gain: 1.4, every: 3, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { dur: 140, amp: 0.7, rot: 2, weight: 750, color: "#c22f4b" },
  },
  // Крупные буквы влетают по одной и остаются трястись, облачко вздрагивает.
  yell: {
    ru: "крик",
    type: { pre: 200, rate: 0.9, post: 220, pitch: 1.38, gain: 2.1, every: 1, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { dur: 110, amp: 1, rot: 3, size: 1.34, pop: 220, shake: 4, color: "#d11f3f" },
    onGo(fx, c) {
      c.jolt(c.P.shake);
      c.tone({ f: 220, f2: 140, d: 0.12, type: "sawtooth", g: 0.05 });
    },
  },
  // Слово впечатывается по слогам, с дефисами; каждый слог падает с глухим ударом.
  syl: {
    ru: "по слогам",
    ok: (word) => /^[а-яё]+( [а-яё]+)*$/i.test(word),
    type: { pre: 380, rate: 1, post: 260, pitch: 0.6, gain: 0, every: 3, climb: 0, wave: "square", whole: 1, one: 0 },
    P: { gap: 340, dur: 260, drop: 7, from: 1.5, size: 0.92, shake: 2.5, color: "#1d1830" },
    setup(fx, c) {
      const V = "аеёиоуыэюя", SON = "йрлмн", SIGN = "ьъ", doc = fx.ownerDocument;
      for (const w of c.words) {
        const ls = [...w.querySelectorAll(".tw")];
        if (!ls.length) continue;
        const ch = ls.map((l) => String(l.textContent).toLowerCase()), vs = [], cuts = [0];
        ch.forEach((x, i) => { if (V.includes(x)) vs.push(i); });
        for (let k = 0; k + 1 < vs.length; k++) {
          const a = vs[k] + 1, b = vs[k + 1];
          let cut = a;
          if (b - a === 1 && ("й" + SIGN).includes(ch[a])) cut = b;
          else if (b - a >= 2) {
            const x = ch[a], y = ch[a + 1];
            if (x === "й" || x === y || SIGN.includes(y) || (SON.includes(x) && !SON.includes(y))) cut = a + 1;
            while (cut < b && SIGN.includes(ch[cut])) cut++;
          }
          cuts.push(cut);
        }
        cuts.push(ls.length);
        for (let k = 0; k + 1 < cuts.length; k++) {
          const sy = doc.createElement("span");
          sy.className = "sy";
          if (k) {
            const hy = doc.createElement("i");
            hy.className = "hy"; hy.setAttribute("aria-hidden", "true"); hy.textContent = "-";
            sy.append(hy);
          }
          sy.append(...ls.slice(cuts[k], cuts[k + 1]));
          w.append(sy);
        }
      }
    },
    hold(fx, c) {
      const n = fx.querySelectorAll(".sy").length || 1;
      return Math.max(0, n - 1) * c.P.gap + c.P.dur * 0.6;
    },
    onGo(fx, c) {
      const sy = [...fx.querySelectorAll(".sy")];
      const step = (k) => {
        if (k >= sy.length) return;
        const last = k === sy.length - 1;
        sy[k].classList.add("hit");
        /* удар — на середине падения; последний слог бьёт ниже и сильнее */
        c.later(c.P.dur * 0.5, () => {
          c.tone({ f: last ? 150 : 190, f2: last ? 46 : 60, d: last ? 0.2 : 0.13, type: "sine", g: last ? 0.1 : 0.08 });
          c.noise({ d: 0.05, g: 0.04, hp: 500 });
          c.jolt(last ? c.P.shake : c.P.shake * 0.5);
        });
        if (!last) c.later(c.P.gap, () => step(k + 1));
      };
      step(0);
    },
    final(fx, c) {
      [...fx.querySelectorAll(".sy")].forEach((s, k) => { s.style.animationDelay = k * c.P.gap + "ms"; s.classList.add("hit"); });
    },
  },
  // Слово подпрыгивает с «чпоком», из него летят цветные бумажки, потом буквы подмигивают цветом.
  confetti: {
    ru: "конфетти",
    type: { pre: 140, rate: 0.9, post: 260, pitch: 1.2, gain: 1, every: 3, climb: 1, wave: "square", whole: 0, one: 0 },
    P: { pop: 420, jump: 4, count: 12, wink: 3000, c1: "#d6336c", c2: "#1c7ed6", c3: "#1e8e3e" },
    onGo(fx, c) {
      c.later(c.P.pop * 0.25, () => {
        c.tone({ f: 320, f2: 760, d: 0.05, type: "sine", g: 0.08 });
        c.noise({ d: 0.03, g: 0.03, hp: 2600 });
        const cols = [c.P.c1, c.P.c2, c.P.c3, "#f2c661"], per = c.P.count / c.words.length;
        for (const w of c.words) c.sparkle(w, per, cols, "rect");
        c.bell(0.08, 1047, 0.022, 0.4);
        c.bell(0.17, 1319, 0.022, 0.4);
        c.bell(0.26, 1568, 0.026, 0.55);
      });
    },
  },
  // По буквам бежит золотой блик; допечатанное слово вырастает, искрит и дышит.
  gold: {
    ru: "золото",
    type: { pre: 320, rate: 1.7, post: 350, pitch: 1.1, gain: 1.2, every: 1, climb: 2, wave: "triangle", whole: 0, one: 0 },
    P: { shine: 2200, grow: 700, peak: 1.5, rest: 1.12, breath: 1700, mid: "#c98f10", glint: "#f6cf58" },
    onGo(fx, c) {
      c.bell(0, 1760, 0.035, 0.5);
      c.bell(0.09, 2637, 0.025, 0.5);
      c.sparkle(c.w);
    },
  },
  // Число набегает от единицы до своего значения, а в конце вырастает и искрит, как золото.
  count: {
    ru: "счёт",
    ok: (word) => /^\d[\d\s]*$/.test(word) && Number(word.replace(/\s/g, "")) >= 2,
    type: { pre: 160, rate: 1, post: 350, pitch: 1, gain: 1, every: 3, climb: 0, wave: "square", whole: 1, one: 1 },
    P: { step: 70, tick: 160, grow: 700, peak: 1.5, rest: 1.12, breath: 1700, color: "#ff8093" },
    setup(fx, c) {
      /* _to — само число, _n — сколько шагов: до 28 считает подряд, большее число идёт теми же 28 шагами через несколько
         (около 2 с при шаге 70 мс), и последний шаг — соседний с итогом */
      fx._to = Math.max(1, parseInt(String(c.w.textContent).replace(/\s/g, ""), 10) || 3);
      fx._n = Math.min(fx._to, 28);
      /* в оригинале: 70 мс на шаг, а для чисел до 6 — 200 мс (то есть в 20/7 раза дольше) */
      fx._dt = fx._n > 6 ? c.P.step : Math.round((c.P.step * 20) / 7);
      for (const w of c.words) w.dataset.n = "";
    },
    hold(fx, c) { return (fx._n || 0) * (fx._dt || 0); },
    onGo(fx, c) {
      const w = c.w, n = fx._n, end = w.dataset.t;
      let k = 0;
      const tick = () => {
        k++;
        w.dataset.n = k >= n ? end : String(Math.round((fx._to * k) / n));
        w.classList.remove("tick"); void w.offsetWidth; w.classList.add("tick");
        c.tone({ f: 500 * Math.pow(2, Math.min(k, 14) / 12), d: 0.05, type: "triangle", g: 0.05 });
        if (k < n) c.later(fx._dt, tick);
        else { for (const o of c.words) o.dataset.n = o.dataset.t; fx.classList.add("fin"); c.bell(0, 1976, 0.035, 0.5); c.sparkle(w); }
      };
      tick();
    },
    final(fx, c) { for (const w of c.words) w.dataset.n = w.dataset.t; },
  },
  // Слово бьётся, как сердце: двойной удар, и вверх улетает сердечко.
  pulse: {
    ru: "пульс",
    type: { pre: 200, rate: 1.3, post: 0, pitch: 1.12, gain: 0.8, every: 3, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { dur: 1150, amp: 0.17, amp2: 0.1, hdur: 1600, rise: 17, color: "#d6336c", hcolor: "#f06595" },
    onGo(fx, c) {
      const gap = 0.2 * c.P.dur / 1150;
      [0, gap].forEach((t) => c.tone({ t, f: 95, f2: 70, d: 0.1, type: "sine", g: 0.09 }));
    },
  },
  // Слова мельче и серее, буквы мягко мерцают — сказано вполголоса.
  whisper: {
    ru: "шёпот",
    type: { pre: 280, rate: 1.5, post: 0, pitch: 1.1, gain: 0.32, every: 3, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { dur: 2600, lag: 55, dim: 0.58, size: 0.84, color: "#77708f" },
  },
  // Буквы по очереди провисают, а с последнего слова срывается капля.
  drip: {
    ru: "капля",
    type: { pre: 200, rate: 2, post: 0, pitch: 0.7, gain: 0.7, every: 3, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { dur: 2800, lag: 140, sag: 2.5, stretch: 1.24, fall: 15, color: "#3f73c9", dcolor: "#5b93ea" },
  },
  // Буквы с конца слова по очереди клонятся вниз и блёкнут, последняя почти падает.
  wilt: {
    ru: "увядает",
    type: { pre: 220, rate: 1.6, post: 520, pitch: 0.82, gain: 0.7, every: 3, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { dur: 800, step: 110, bend: 12, fall: 28, sigh: 4500, lift: 1, color: "#7d7389" },
    onGo(fx, c) {
      const n = fx.querySelectorAll(".fw .tw").length || 5;
      const sec = Math.min(1.6, Math.max(0.4, (c.P.dur + n * c.P.step) / 1000));
      c.tone({ f: 440, f2: 215, d: sec, type: "sine", g: 0.045 });
    },
  },
  // Слово нехотя растягивается по буквам и сжимается обратно.
  str: {
    ru: "нехотя",
    type: { pre: 120, rate: 3.2, post: 0, pitch: 0.8, gain: 0.9, every: 2, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { dur: 1400, wide: 0.16, weight: 650, color: "#7a5a2c" },
    setup(fx, c) {
      for (const w of c.words) {
        const ls = [...w.querySelectorAll(".tw")];
        w.style.setProperty("--m", ls.length);
        ls.forEach((l, j) => { l.style.setProperty("--j", j); l.style.setProperty("--c", (ls.length - 1) / 2); });
      }
    },
  },
  // Буквы одна за другой оседают лесенкой, будто слово сползает со строки, потом нехотя подтягиваются.
  slump: {
    ru: "сползает",
    type: { pre: 220, rate: 1.9, post: 320, pitch: 0.82, gain: 0.7, every: 2, climb: -1, wave: "triangle", whole: 0, one: 0 },
    P: { cycle: 5200, drop: 6, tilt: 14, lag: 90, color: "#70738a" },
    onGo(fx, c) {
      c.tone({ f: 330, f2: 170, d: 0.38, type: "sine", g: 0.05 });
    },
  },
  // Слово выскакивает со вспышкой, потом изредка дёргается.
  jolt: {
    ru: "ой",
    type: { pre: 120, rate: 1, post: 380, pitch: 1.5, gain: 1.6, every: 3, climb: 0, wave: "square", whole: 1, one: 0 },
    P: { dur: 550, big: 1.5, stag: 90, period: 3000, amp: 2, color: "#c2410c", flash: "#ffd43b" },
    hold(fx, c) { return Math.max(-(c.T.post || 0), Math.round((c.P.dur - 550) * 380 / 550)); },
    onGo(fx, c) { c.tone({ f: 620, f2: 1500, d: 0.1, g: 0.06 }); },
  },
  // Слово дёргается рывками и на миг расслаивается на два цветных слоя.
  glitch: {
    ru: "сбой",
    type: { pre: 250, rate: 1, post: 150, pitch: 1.6, gain: 0.9, every: 1, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { period: 2600, amp: 2, skew: 14, split: 2.5, color: "#1d1830", c1: "#00b8d4", c2: "#ff2e7e" },
    onGo(fx, c) {
      const k = c.P.period / 2600;
      [0, 0.06, 0.5].forEach((t) => c.tone({ t: t * k, f: 180 + Math.random() * 900, d: 0.04, type: "square", g: 0.03 }));
    },
  },
  // Слово зачёркивается и улетает, сверху встаёт исправленное.
  fix: {
    ru: "правка", plainArg: true,
    type: { pre: 0, rate: 1, post: 1500, pitch: 1, gain: 1, every: 3, climb: 0, wave: "square", whole: 0, one: 1 },
    P: { wait: 800, strike: 280, out: 400, into: 500, tilt: -2, color: "#6b3fd4", line: "#c22f4b" },
    setup(fx, c) {
      c.words.forEach((w, wi) => {
        const fo = document.createElement("span");
        fo.className = "fo";
        fo.append(...w.childNodes);
        w.append(fo);
        if (wi) return;
        const ft = document.createElement("span");
        ft.className = "ft";
        ft.setAttribute("aria-hidden", "true");
        ft.textContent = c.arg || "…";
        w.append(ft);
      });
    },
    hold(fx, c) {
      return Math.max(-(c.T.post || 0), c.P.wait + c.P.out * 0.75 + c.P.into - 1600);
    },
    onGo(fx, c) {
      c.noise({ d: 0.2, g: 0.035, hp: 2600 });
      /* через c.later, а не отложенным звуком: реплику сменили или облачко закрыли — тон не прозвучит */
      c.later(c.P.wait + c.P.out * 0.75, () => c.tone({ f: 520, f2: 880, d: 0.09, g: 0.05 }));
    },
  },
  // Вокруг слова выскакивают крупные насмешливые кавычки и сгибаются, как пальцы; слово — курсивом.
  quote: {
    ru: "кавычки",
    type: { pre: 220, rate: 1.4, post: 160, pitch: 1.15, gain: 0.9, every: 3, climb: 0, wave: "square", whole: 0, one: 1 },
    P: { dur: 620, sway: 2600, bend: 16, size: 1.4, lean: -3, color: "#8a3d94", qcolor: "#d6478f" },
    hold(fx, c) { return c.P.dur * 0.75; },
    onGo(fx, c) {
      const tick = (f) => () => c.tone({ f, f2: f * 0.72, d: 0.045, type: "triangle", g: 0.06 });
      c.later(c.P.dur * 0.45, tick(920));
      c.later(c.P.dur * 0.75, tick(820));
    },
  },
  // По словам проезжает жёлтый маркер.
  mark: {
    ru: "маркер", ptOut: true,
    type: { pre: 0, rate: 1.2, post: 300, pitch: 1, gain: 1, every: 3, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { dur: 550, color: "#ffd43b", dense: 88, top: 10, bot: 8, weight: 650 },
    onGo(fx, c) {
      c.noise({ d: 0.32 * c.P.dur / 550, g: 0.018, hp: 3200 });
    },
  },
  // Слово медленно дышит: чуть растёт и мягко светится.
  breath: {
    ru: "дыхание",
    type: { pre: 200, rate: 1.6, post: 0, pitch: 0.9, gain: 0.7, every: 3, climb: 0, wave: "square", whole: 0, one: 0 },
    P: { dur: 3200, grow: 1.07, glow: 9, dense: 60, color: "#5b3fc4", halo: "#6b3fd4", weight: 700 },
  },
};

// Имя пометки сравнивается без регистра, без лишних пробелов и без разницы «е / ё»: «[Счет]» — то же, что «[счёт]».
const wordfxName = (s) => String(s).toLowerCase().trim().replace(/\s+/g, " ").replace(/ё/g, "е");
const WORDFX_RU = Object.fromEntries(Object.entries(WORDFX).map(([id, e]) => [wordfxName(e.ru), id]));
const WORDFX_OWN = "\u2063"; // невидимый знак в начале своей реплики с пометками (ставит lineItem в lines.js, снимает say)
const WORDFX_MAX = 2; // правило вкуса: не больше двух слов с эффектом на реплику — остальные пометки просто снимаются
const WORDFX_LONG = 140; // длинный текст печатается быстрее и листается — в нём эффектов нет
const WORDFX_WORD = 22; // слово (или фраза одним куском) длиннее не переносится и вылезло бы из облачка — идёт без эффекта
const WORDFX_PHRASE = 40; // вся помеченная фраза
const WORDFX_MARK = /\[([а-яё][а-яё ]*)(?:=([^\[\]<>\n]*))?\]([^\[\]<>\n]+)\[\/\]/gi;
const WORDFX_OPEN = /\[([а-яё][а-яё ]*)(?:=[^\[\]<>\n]*)?\]/gi;

/** Разобранная пометка: null — имя не из списка (текст не трогаем); fx: false — имя наше, но оживить нельзя (пусто, слишком
 *  длинно, правка без нового слова, счёт не на числе…) — слово идёт обычным текстом. plain — что стоит в чистом тексте. */
function wordfxPick(name, arg, inner) {
  const id = WORDFX_RU[wordfxName(name)];
  if (!id) return null;
  const e = WORDFX[id], word = inner.trim().replace(/\s+/g, " "), to = (arg ?? "").trim();
  const lead = inner.match(/^\s*/)[0], trail = word ? inner.match(/\s*$/)[0] : "";
  const bare = word.replace(/&(amp|lt|gt|quot);/g, "x"); // длину считаем по буквам, а не по записи «&amp;»
  const parts = e.type.one ? [bare] : bare.split(" ");
  const fx = !!word && bare.length <= WORDFX_PHRASE && parts.every((w) => w.length <= WORDFX_WORD) && (!e.plainArg || !!to) && (!e.ok || e.ok(bare));
  return { id, e, fx, word, to, lead, trail, plain: fx && e.plainArg ? lead + to + trail : inner };
}
/** Обрывки пометок, которые не сложились в пару (вложенные, незакрытые): скобки с нашим именем убираются, слово остаётся. */
function wordfxSweep(s) {
  let hit = false;
  s = s.replace(WORDFX_OPEN, (all, name) => (WORDFX_RU[wordfxName(name)] ? ((hit = true), "") : all));
  return hit ? s.replace(/\[\/\]/g, "") : s;
}
/** Текст реплики без пометок: «Срок — [крик]сегодня[/]» → «Срок — сегодня». У правки остаётся исправленное слово. */
function wordfxStrip(text) {
  return wordfxSweep(String(text ?? "").replace(WORDFX_MARK, (all, name, arg, inner) => wordfxPick(name, arg, inner)?.plain ?? all));
}
/** Готовый HTML реплики (после tgHtml) → тот же HTML, где помеченные слова обёрнуты: .fx > .fw (слово) [+ .pt — знак за словом].
 *  Буквы — «кирпичики» (inline-block), и строка могла бы порваться между словом и знаком после него, поэтому знаки, стоящие
 *  вплотную за словом, уходят в одну неразрывную обёртку с его последним словом (.nb > .fw + .pt). */
function wordfxHtml(html) {
  let out = "", last = 0, n = 0;
  WORDFX_MARK.lastIndex = 0;
  for (let m; (m = WORDFX_MARK.exec(html)); ) {
    const p = wordfxPick(m[1], m[2], m[3]);
    if (!p) continue;
    out += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (!p.fx || n >= WORDFX_MAX) { out += p.plain; continue; }
    n++;
    // знак вплотную за словом (если пометка не кончалась пробелом)
    const pt = p.trail ? "" : (html.slice(last).match(/^[^\s<&\[]+/) ?? [""])[0];
    last += pt.length;
    WORDFX_MARK.lastIndex = last;
    const ws = p.e.type.one ? [p.word] : p.word.split(" ");
    // ptOut (маркер): заливка лежит на всей пометке — знак остаётся снаружи, обычным текстом
    const inPt = p.e.ptOut ? "" : pt;
    const body = ws.map((w, i) => (i === ws.length - 1 && inPt ? `<span class="nb"><span class="fw">${w}</span><span class="pt">${inPt}</span></span>` : `<span class="fw">${w}</span>`)).join(" ");
    const fx = `<span class="fx fx-${p.id}" data-fx="${p.id}"${p.e.plainArg ? ` data-arg="${p.to.replace(/"/g, "&quot;")}"` : ""}>${body}</span>`;
    out += p.lead + (p.e.ptOut && pt ? (ws.length === 1 ? `<span class="nb">${fx}${pt}</span>` : fx + pt) : fx) + p.trail;
  }
  return wordfxSweep(out + html.slice(last));
}

// --- звук и движение для зацепок эффектов: тихо, только пока звук печати включён ---
function wordfxQuiet() { return cfg.mute || cfg.typing !== "sound"; }
function wordfxTone({ f = 660, f2 = null, t = 0, d = 0.09, type = "triangle", g = 0.07 } = {}) {
  if (wordfxQuiet()) return;
  try {
    actx ??= new AudioContext();
    const o = actx.createOscillator(), v = actx.createGain(), t0 = actx.currentTime + t;
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + d);
    v.gain.setValueAtTime(0.0001, t0);
    v.gain.exponentialRampToValueAtTime(g, t0 + 0.012);
    v.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(v).connect(actx.destination);
    o.start(t0);
    o.stop(t0 + d + 0.03);
  } catch {}
}
function wordfxNoise({ t = 0, d = 0.12, g = 0.05, hp = 1800 } = {}) {
  if (wordfxQuiet()) return;
  try {
    actx ??= new AudioContext();
    const n = Math.floor(actx.sampleRate * d), buf = actx.createBuffer(1, n, actx.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = actx.createBufferSource(), v = actx.createGain(), f = actx.createBiquadFilter();
    s.buffer = buf;
    f.type = "highpass";
    f.frequency.value = hp;
    v.gain.value = g;
    s.connect(f).connect(v).connect(actx.destination);
    s.start(actx.currentTime + t);
  } catch {}
}
// Колокольчик: основной тон и призвук ×2,76 вдвое короче (как «голоса» в moodsound.js).
function wordfxBell(t, f, vol = 0.03, dur = 0.5) {
  if (wordfxQuiet()) return;
  try {
    actx ??= new AudioContext();
    const out = actx.createGain(), lp = actx.createBiquadFilter(), T = actx.currentTime + 0.1 + t;
    out.gain.value = 1.2;
    lp.type = "lowpass";
    lp.frequency.value = 6500;
    out.connect(lp).connect(actx.destination);
    for (const [ff, len, vv] of [[f, dur, vol], [f * 2.76, dur * 0.5, vol * 0.35]]) {
      const o = actx.createOscillator(), g = actx.createGain(), y = T + len;
      o.frequency.setValueAtTime(ff, T);
      g.gain.setValueAtTime(0.0001, T);
      g.gain.exponentialRampToValueAtTime(vv, T + 0.004);
      g.gain.setValueAtTime(vv, Math.max(T + 0.004, y - len * 0.35));
      g.gain.exponentialRampToValueAtTime(0.0001, y);
      o.connect(g).connect(out);
      o.start(T);
      o.stop(y + 0.05);
    }
  } catch {}
}
const wordfxCalm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function wordfxJolt(px = 3) {
  const b = $("#bubble");
  if (!b || !px || wordfxCalm()) return;
  // Пока облачко трясётся, fitBubble его не меряет (поворот меняет габариты) — и перемеряет, когда встряска кончилась.
  b._jolt = b.animate([{ transform: "none" }, { transform: `translate(${px}px,${-px}px) rotate(-1.2deg)` }, { transform: `translate(${-px}px,${px * 0.6}px) rotate(1deg)` }, { transform: `translate(${px * 0.4}px,0)` }, { transform: "none" }], { duration: 260, easing: "ease-out" });
  b._jolt.finished.then(() => fitBubble(), () => {});
}
// Разлёт искр из середины слова поверх облачка: shape — "star" (✦), "dot", "rect" (бумажки).
function wordfxSparkle(el, n = 9, colors = ["#f2c661", "#fff1ad", "#d39a17", "#fff"], shape = "star") {
  const b = $("#bubble");
  if (!b || !el || !n || wordfxCalm()) return;
  const r = el.getBoundingClientRect(), R = b.getBoundingClientRect();
  if (!R.width) return;
  const x = r.left + r.width / 2 - R.left, y = r.top + r.height / 2 - R.top, spread = 36, size = 5, gravity = 14, life = 850;
  for (let i = 0; i < Math.round(n); i++) {
    const p = document.createElement("i"), ang = Math.random() * Math.PI * 2, rr = spread * (0.45 + Math.random() * 0.55);
    const dx = Math.cos(ang) * rr, dy = Math.sin(ang) * rr - spread * 0.25, s = size * (0.6 + Math.random() * 0.8), col = colors[i % colors.length];
    p.className = "fx-spark";
    p.setAttribute("aria-hidden", "true");
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    if (shape === "star") { p.textContent = "✦"; p.style.color = col; p.style.fontSize = `${s * 2}px`; }
    else { p.style.width = `${s}px`; p.style.height = `${shape === "rect" ? s * 1.5 : s}px`; p.style.margin = `${-s / 2}px`; p.style.borderRadius = shape === "dot" ? "50%" : "2px"; p.style.background = col; }
    b.append(p);
    p.animate([{ transform: "translate(0,0) rotate(0) scale(.4)", opacity: 1 }, { transform: `translate(${dx * 0.8}px,${dy * 0.8}px) rotate(${Math.random() * 360}deg) scale(1)`, opacity: 1, offset: 0.45 }, { transform: `translate(${dx}px,${dy + gravity}px) rotate(${Math.random() * 720}deg) scale(.8)`, opacity: 0 }],
      { duration: life * (0.75 + Math.random() * 0.5), easing: "cubic-bezier(.15,.7,.3,1)" }).finished.then(() => p.remove(), () => p.remove());
  }
}

/** Подготовить помеченные слова к печати (planType зовёт после нарезки букв): номера букв и слов, разметка эффекта. */
function wordfxPrep(box) {
  for (const p of $("#bubble").querySelectorAll(".fx-spark")) p.remove();
  for (const fx of box.querySelectorAll(".fx")) {
    const e = WORDFX[fx.dataset.fx];
    const ls = [...fx.querySelectorAll(".tw")].filter((l) => !l.closest(".pt"));
    if (!e || !ls.length) { fx.className = ""; continue; }
    fx._e = e;
    fx._first = ls[0];
    fx._last = ls.at(-1);
    ls.forEach((l, i) => { l.style.setProperty("--i", i); l.style.setProperty("--h", (ls.length - 1) / 2); l.style.setProperty("--n", ls.length); l._fx = fx; });
    const words = [...fx.querySelectorAll(".fw")];
    words.forEach((w, wi) => { w.dataset.t = w.textContent; w.style.setProperty("--w", wi); w.classList.toggle("lw", wi === words.length - 1); });
    const alive = () => !fx._cut && fx.isConnected && !$("#bubble").classList.contains("hidden");
    fx._c = {
      id: fx.dataset.fx, fx, P: e.P, T: e.type, w: words[0], words, arg: fx.dataset.arg ?? null, alive,
      tone: wordfxTone, noise: wordfxNoise, bell: wordfxBell, jolt: wordfxJolt, sparkle: wordfxSparkle,
      later: (ms, fn) => setTimeout(() => { if (alive()) fn(); }, ms),
    };
    wordfxHook(fx, "setup");
  }
}
function wordfxHook(fx, name) {
  try { return fx._e[name]?.(fx, fx._c); } catch (err) { console.error("wordfx", fx.dataset.fx, name, err); }
}
/** Время буквы помеченного слова (planType): пауза перед словом, свой темп, «слово целиком», пауза после.
 *  t — время по плану до этой буквы, step — шаг печати, pause — пауза после знака препинания. Обычная буква — null. */
function wordfxStep(sp, t, step, pause) {
  const fx = sp._fx;
  if (!fx) return null;
  const k = fx._e.type;
  if (sp === fx._first) { t += k.pre; fx._t0 = t; }
  const extra = () => Math.max(0, k.post + (wordfxHook(fx, "hold") || 0));
  if (k.whole) return { at: fx._t0, next: sp === fx._last ? fx._t0 + extra() : t };
  return { at: t, next: t + step * k.rate + pause + (sp === fx._last ? extra() : 0) };
}
/** Буква показана (runType): первая буква слова — класс in, последняя — go и действие эффекта. */
function wordfxShown(sp) {
  const fx = sp._fx;
  if (!fx) return;
  if (sp === fx._first) { fx.classList.add("in"); wordfxHook(fx, "onIn"); }
  if (sp === fx._last) {
    fx.classList.add("go");
    // До какого момента слово «занято» действием по таймерам (счёт бежит, слоги падают): щелчок-пропуск
    // в это время обрывает его. Только у эффектов со своим конечным видом (final) — остальным обрывать нечего.
    if (fx._e.final) fx._busy = performance.now() + Math.max(0, fx._e.type.post + (wordfxHook(fx, "hold") || 0));
    wordfxHook(fx, "onGo");
  }
}
/** «Бип» буквы помеченного слова: своя высота, громкость и частота; false — буква обычная, «бип» как всегда (typeBlip). */
function wordfxBlip(sp, n, base) {
  const fx = sp?._fx;
  if (!fx) return false;
  const k = fx._e.type;
  if (n % Math.max(1, k.every) || k.gain <= 0) return true;
  const i = Number(sp.style.getPropertyValue("--i")) || 0;
  wordfxTone({ f: base * k.pitch * Math.pow(2, (k.climb * i) / 12) * (0.94 + Math.random() * 0.12), d: 0.055, type: k.wave, g: Math.min(0.1, 0.045 * k.gain) });
  return true;
}
/** Печать закончена или её не было: недопечатанные слова сразу в конечном виде (без звука и разовых действий).
 *  cut — печать оборвали щелчком: слово, у которого действие ещё идёт (счёт, слоги), тоже сразу встаёт в конечный вид —
 *  его таймеры гаснут, а разовые анимации снимаются (класс cut). */
function wordfxFinish(box, cut = false) {
  for (const fx of box.querySelectorAll(".fx")) {
    if (!fx._e) continue;
    if (fx.classList.contains("go")) {
      if (!cut || !(fx._busy > performance.now())) continue;
      fx._cut = true;
      fx.classList.add("cut");
    }
    fx.classList.add("in", "go", "fin");
    wordfxHook(fx, "final");
  }
}
/** Реплика без печати (печать выключена, «меньше движения», кнопка с самонажатием): буквы помеченных слов всё равно
 *  нарезаются — на них держится вид эффекта, — и слово сразу встаёт в конечный вид. */
function wordfxStatic(box) {
  const fxs = [...box.querySelectorAll(".fx")];
  if (!fxs.length) return;
  for (const fx of fxs) {
    const walk = (n) => {
      for (const c of [...n.childNodes]) {
        if (c.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const ch of c.data) { const sp = document.createElement("span"); sp.className = "tw on"; sp.textContent = ch; frag.appendChild(sp); }
          c.replaceWith(frag);
        } else if (c.nodeType === 1) walk(c);
      }
    };
    walk(fx);
  }
  wordfxPrep(box);
  wordfxFinish(box);
}
