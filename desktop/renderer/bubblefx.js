"use strict";
// Облачко-актёр, значки у головы и правила вкуса (с 20.11.2026; вид — bubblefx.css). Перенесено из ревью
// docs/review/ревью-опыт-праздники-облачка-2026-11-20.html (разделы «Облачко превращается», «Значки из манги», «Приёмы кадра»,
// «Правила вкуса»). Зовёт say() в widget.js.
//  · Превращения облачка (одно на реплику, после печати): тает — грусть, сдувается — усталость, сердце — благодарность
//    (вы написали «спасибо»), цветы — похвала (гордость). Уходит облачко тоже по-своему: стекает лужицей, падает сдутым,
//    роняет цветы (bubblefxExit, из hideBubble).
//  · Значки у головы (bubblefxMark): линии уныния — на каждой грустной реплике; капля пота — когда выглядывает из-за панели.
//  · Упала за панель — от большого удивления («?!» в удивлённой реплике): бледнеет, падает за край панели, выглядывает, вылезает.
//  · Правила вкуса — общие со словами с характером (wordfx.js): эффект не чаще одной реплики из трёх, не в серьёзном
//    (здоровье, деньги, плохие новости), не в длинном тексте, при «меньше движения» — без движения. Настройка «Эффекты»
//    (cfg.fx): «quiet» — без эффектов (и без походки букв), «normal» — по правилам, «festive» — без правила «1 из 3».

const BUBBLEFX_EVERY = 3; // эффект — не чаще одной реплики из трёх
// Серьёзное: здоровье, деньги, плохие новости — такие реплики идут ровным текстом.
const BUBBLEFX_SERIOUS = /врач|болезн|болит|болел|больн|давлени|таблет|лекарств|анализ|температур|здоровь|деньг|денег|долг|кредит|зарплат|штраф|налог|₽|руб\.|рубл|умер|похорон|увол|авари/i;
const BUBBLEFX_SHORT = 90; // превращение облачка — только у короткой реплики без карточек и кнопок
const BUBBLEFX_HOLD = 4200; // столько идут повторы (капли, стук сердца, лепестки) — потом облачко просто стоит в новом виде
let bubblefxSince = 99; // сколько реплик прошло с последнего эффекта
let bubblefxRun = null; // идущее превращение: { kind, on, calm, timers, anims, b, shape, deco, exit }

function bubblefxLevel() { return cfg.fx === "quiet" || cfg.fx === "festive" ? cfg.fx : "normal"; }
function bubblefxCalm() { return matchMedia("(prefers-reduced-motion: reduce)").matches; }

/** Правила вкуса: можно ли этой реплике эффект — слова с характером или превращение облачка. say() зовёт один раз на реплику. */
function bubblefxAllow(plain) {
  bubblefxSince++;
  if (bubblefxLevel() === "quiet") return false;
  if (BUBBLEFX_SERIOUS.test(plain)) return false;
  return bubblefxLevel() === "festive" || bubblefxSince >= BUBBLEFX_EVERY;
}
/** Эффект показан — следующие две реплики идут ровно. */
function bubblefxUsed() { bubblefxSince = 0; }

/** Какое превращение подходит реплике (или null). weighty — у облачка карточки, кнопки, длинный текст. */
function bubblefxPick({ emotion = "neutral", heard = "", plain = "", weighty = false } = {}) {
  if (weighty || plain.length > BUBBLEFX_SHORT || bubblefxCalm()) return null;
  if (emotion === "surprised" && /\?!|!\?/.test(plain) && !collapsed && !$("#stage").classList.contains("no-maid")) return "fall";
  if (/спасиб|благодар/i.test(heard) && plain.length <= 48) return "heart";
  if (emotion === "sad") return "melt";
  if (emotion === "sleepy") return "deflate";
  if (emotion === "proud") return "bloom";
  return null;
}

// --- общее: слой частиц, координаты, полёт ---
const bubblefxRnd = (a, b) => a + Math.random() * (b - a);
function bubblefxEl(cls, css, parent, html) {
  const e = document.createElement("i");
  e.className = cls;
  if (css) e.style.cssText = css; // через CSSOM: CSP запрещает только атрибут style в разметке
  if (html) e.innerHTML = html;
  if (parent) parent.append(e);
  return e;
}
/** Слой частиц поверх всего окна (капли, пух, лепестки, «призрак» уходящего облачка). */
function bubblefxLayer() {
  let l = $("#bfxLayer");
  if (!l) {
    l = document.createElement("div");
    l.id = "bfxLayer";
    l.className = "bfx-layer";
    $("#stage").append(l);
  }
  return l;
}
function bubblefxRel(e) {
  const a = e.getBoundingClientRect(), s = $("#stage").getBoundingClientRect();
  return { x: a.left - s.left, y: a.top - s.top, w: a.width, h: a.height };
}
/** Пол — верх панели (свёрнутой — карточки): на него падают капли и пыль. */
function bubblefxFloor() {
  const w = collapsed ? $("#mini") : $("#w");
  return w && w.offsetHeight ? bubblefxRel(w).y : $("#stage").offsetHeight;
}
/** Полёт частицы: скорость, тяжесть, вращение, отскок от пола; по окончании частица удаляется. */
function bubblefxFling(e, { vx = 0, vy = 0, g = 1500, spin = 0, life = 1200, floor = null, bounce = 0.3, fade = 0.3, delay = 0, s0 = 1, s1 = 1 } = {}) {
  if (bubblefxCalm()) return void e.remove();
  const n = 26, dt = life / 1000 / n, kf = [];
  let x = 0, y = 0, r = 0;
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    kf.push({ transform: `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${r.toFixed(0)}deg) scale(${(s0 + (s1 - s0) * k).toFixed(2)})`, opacity: k < 1 - fade ? 1 : Math.max(0, (1 - k) / fade) });
    vy += g * dt; x += vx * dt; y += vy * dt; r += spin * dt;
    if (floor != null && y > floor) { y = floor; vy = -vy * bounce; vx *= 0.55; spin *= 0.4; if (Math.abs(vy) < 70) vy = 0; }
  }
  e.animate(kf, { duration: life, delay, easing: "linear", fill: "both" }).finished.then(() => e.remove(), () => e.remove());
}
function bubblefxDust(x, y, n, dir) {
  for (let i = 0; i < n; i++) bubblefxFling(bubblefxEl("bfx-dust", `left:${x}px;top:${y}px`, bubblefxLayer()), { vx: dir * bubblefxRnd(50, 170), vy: bubblefxRnd(-90, -20), g: 220, life: bubblefxRnd(550, 800), fade: 0.6, s0: 0.5, s1: 2.2 });
}

// Звуки — те же тоны, что у слов с характером (wordfxTone / wordfxNoise): молчат при «без звука» и «печатает тихо».
const BUBBLEFX_SND = {
  drip: () => wordfxTone({ f: bubblefxRnd(1000, 1300), f2: 520, d: 0.07, type: "sine", g: 0.05 }),
  melt: () => wordfxTone({ f: 420, f2: 150, d: 0.9, type: "sine", g: 0.04 }),
  pff: () => { wordfxNoise({ d: 1, g: 0.04, hp: 1100 }); wordfxTone({ f: 330, f2: 110, d: 0.95, type: "sine", g: 0.025 }); },
  heart: () => { wordfxTone({ f: 82, f2: 52, d: 0.12, type: "sine", g: 0.1 }); wordfxTone({ f: 74, f2: 48, t: 0.19, d: 0.12, type: "sine", g: 0.07 }); },
  bell: (i, t = 0) => wordfxTone({ f: [1047, 1175, 1319, 1568, 1760, 2093, 2349, 2637][i % 8], t, d: 0.32, type: "triangle", g: 0.035 }),
  thud: () => { wordfxTone({ f: 105, f2: 42, d: 0.26, type: "sine", g: 0.1 }); wordfxNoise({ d: 0.12, g: 0.08, hp: 90 }); },
  slide: () => wordfxTone({ f: 1200, f2: 220, d: 0.38, type: "sine", g: 0.05 }),
};

// --- значки у головы ---
const BUBBLEFX_OUT = "#13141a";
const BUBBLEFX_MARK = {
  // Линии уныния: сверху опускаются штрихи и тень, фигурка блёкнет.
  gloom: {
    dim: true,
    setup: (m) => [[8, 62], [20, 90], [33, 70], [46, 100], [59, 78], [72, 95], [84, 60]].forEach(([l, h], i) => bubblefxEl("", `left:${l}%;height:${h}%;animation-delay:${i * 60}ms`, m)),
    snd: () => wordfxTone({ f: 330, f2: 185, d: 0.55, type: "sine", g: 0.04 }),
  },
  // Капля пота: дважды сползает по виску.
  drop: {
    html: `<svg viewBox="0 0 20 28"><path d="M10 2C10 2 2 13 2 18a8 8 0 0 0 16 0C18 13 10 2 10 2Z" fill="#9bdcff" stroke="${BUBBLEFX_OUT}" stroke-width="2.3" stroke-linejoin="round"/><path d="M6.4 18.4a3.6 3.6 0 0 0 2.7 3.7" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
    snd: () => wordfxTone({ f: 1400, f2: 700, d: 0.1, type: "sine", g: 0.04 }),
  },
};
/** Значок у головы горничной на ms миллисекунд. */
function bubblefxMark(name, ms = 2400) {
  const k = BUBBLEFX_MARK[name], maidEl = $("#maid");
  if (!k || !maidEl || bubblefxLevel() === "quiet" || $("#stage").classList.contains("no-maid")) return;
  let box = maidEl.querySelector(".bfx-marks");
  if (!box) box = bubblefxEl("bfx-marks", "", maidEl);
  box.querySelector(`.bfx-mk-${name}`)?.remove();
  const m = bubblefxEl(`bfx-mk bfx-mk-${name}`, "", box, k.html);
  k.setup?.(m);
  k.snd?.();
  if (k.dim) maidEl.classList.add(`bfx-on-${name}`);
  setTimeout(() => {
    m.classList.add("out");
    setTimeout(() => {
      m.remove();
      if (k.dim && !box.querySelector(`.bfx-mk-${name}`)) maidEl.classList.remove(`bfx-on-${name}`);
    }, 220);
  }, ms);
}

// --- превращения облачка ---
const BUBBLEFX_HEART = '<svg class="bfx-heart" viewBox="0 0 100 92"><path d="M50 88C20 66 4 48 4 28C4 12 16 4 28 4C38 4 46 10 50 18C54 10 62 4 72 4C84 4 96 12 96 28C96 48 80 66 50 88Z" fill="#ffd9e6" stroke="#ff86b0" stroke-width="2.6" stroke-linejoin="round"/><path d="M15 27C15 19 21 13 29 13" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>';
const BUBBLEFX_HMINI = '<svg viewBox="0 0 24 22"><path d="M12 20C5 14.5 1.5 11 1.5 6.8C1.5 3.8 3.9 1.5 6.8 1.5C9 1.5 11 2.8 12 4.8C13 2.8 15 1.5 17.2 1.5C20.1 1.5 22.5 3.8 22.5 6.8C22.5 11 19 14.5 12 20Z" fill="#ff7aa8" stroke="#13141a" stroke-width="1.8" stroke-linejoin="round"/><path d="M6 6.5a2.6 2.6 0 0 1 2.4-2" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>';
function bubblefxFlower(i) {
  const c = ["#ff9cc8", "#ffffff", "#ffd36b", "#c7b3ff"][i % 4], e = ["#e0609a", "#b9b3cc", "#d99a1c", "#8a6fe0"][i % 4];
  let p = "";
  for (let k = 0; k < 5; k++) p += `<ellipse cx="0" cy="-5.6" rx="3.5" ry="4.8" transform="rotate(${k * 72})"/>`;
  return `<svg viewBox="-11 -11 22 22"><g fill="${c}" stroke="${e}" stroke-width=".9">${p}</g><circle r="2.7" fill="#f2c661" stroke="#b07c12" stroke-width=".8"/></svg>`;
}
/** Фильтр «жидкого» края для таяния — один раз в документ. */
function bubblefxGoo() {
  if ($("#bfxGoo")) return;
  document.body.insertAdjacentHTML("beforeend", '<svg id="bfxGoo" class="bfx-defs" width="0" height="0" aria-hidden="true"><defs><filter id="bfx-goo" x="-20%" y="-30%" width="140%" height="260%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b"/><feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8"/></filter></defs></svg>');
}

const BUBBLEFX_KINDS = {
  // Тает — грусть: низ облачка оплывает, капли падают на панель; уходя, облачко стекает лужицей.
  melt(run) {
    const { b, shape } = run;
    bubblefxGoo();
    b.classList.add("k-melt");
    const h = b.offsetHeight;
    [0.14, 0.33, 0.52, 0.7, 0.86].forEach((x, i) => {
      const d = bubblefxEl("bfx-drip", `left:${x * 100}%`, shape);
      const drip = () => {
        if (run.calm) return;
        const len = bubblefxRnd(14, 26), dur = bubblefxRnd(900, 1300);
        run.anims.push(d.animate([{ transform: "translateY(0) scaleY(1)" }, { transform: `translateY(${len}px) scaleY(1.35)`, offset: 0.8 }, { transform: "translateY(3px) scaleY(1)" }], { duration: dur, easing: "cubic-bezier(.5,0,.8,.5)" }));
        run.later(dur * 0.8, () => {
          const r = bubblefxRel(b), fl = bubblefxFloor(), x0 = r.x + d.offsetLeft + 7, y0 = r.y + h + len + 4, fall = Math.max(8, fl - y0), tf = Math.sqrt((2 * fall) / 1500) * 1000;
          const dr = bubblefxEl("bfx-drop", `left:${x0}px;top:${y0}px`, bubblefxLayer());
          dr.animate([{ transform: "translateY(0) scaleY(1)" }, { transform: `translateY(${fall}px) scaleY(1.35)` }], { duration: tf, easing: "cubic-bezier(.4,0,1,.6)", fill: "forwards" }).finished.then(() => {
            dr.remove();
            if (!run.on) return;
            BUBBLEFX_SND.drip();
            for (let k = 0; k < 3; k++) bubblefxFling(bubblefxEl("bfx-splash", `left:${x0}px;top:${fl - 1}px`, bubblefxLayer()), { vx: bubblefxRnd(-70, 70), vy: bubblefxRnd(-150, -80), g: 900, life: 380, fade: 0.5 });
          }, () => dr.remove());
          run.later(tf + bubblefxRnd(300, 800), drip);
        });
      };
      run.later(150 + i * 210 + bubblefxRnd(0, 200), drip);
    });
  },
  meltExit(c, r) {
    const dy = Math.max(0, bubblefxFloor() - (r.y + r.h)), shape = c.querySelector(".bfx-shape");
    c.querySelectorAll(".bfx-drip").forEach((e) => e.remove());
    c.querySelector(".bubble-text")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" });
    BUBBLEFX_SND.melt();
    shape.style.transformOrigin = "50% 100%";
    shape.animate([{ transform: "none", opacity: 1 }, { transform: `translateY(${dy * 0.5}px) scale(1.06,.55)`, opacity: 1, offset: 0.5 }, { transform: `translateY(${dy}px) scale(1.2,.12)`, opacity: 1, offset: 0.8 }, { transform: `translateY(${dy}px) scale(1.3,.08)`, opacity: 0 }], { duration: 1300, easing: "cubic-bezier(.45,0,.7,1)", fill: "forwards" })
      .finished.then(() => c.remove(), () => c.remove());
    c.querySelectorAll(".bubble-cards, .bubble-actions, .amend").forEach((e) => (e.style.opacity = "0"));
  },

  // Сдувается — усталость: через полсекунды после текста «пф-ф» — облачко морщится, уменьшается и повисает набок.
  deflate(run) {
    const { b } = run;
    run.later(500, () => {
      b.classList.add("k-flat");
      BUBBLEFX_SND.pff();
      run.anims.push(b.animate([{ transform: "none" }, { transform: "scale(1.04,.9)", offset: 0.12 }, { transform: "scale(.95,.92) rotate(1deg)", offset: 0.3 }, { transform: "scale(.93,.84) rotate(2.5deg) translateY(4px)", offset: 0.5 }, { transform: "scale(.9,.86) rotate(3.5deg) translateY(7px)", offset: 0.72 }, { transform: "scale(.86,.8) rotate(5deg) translateY(10px)" }], { duration: 1050, easing: "ease-out", fill: "forwards" }));
      const r = bubblefxRel(b), left = $("#stage").classList.contains("side-left");
      // воздух выходит из угла напротив хвостика
      const x = left ? r.x + r.w - 8 : r.x + 8, dir = left ? 1 : -1;
      for (let i = 0; i < 7; i++) bubblefxFling(bubblefxEl("bfx-puff", `left:${x}px;top:${r.y + 6}px`, bubblefxLayer()), { vx: dir * bubblefxRnd(70, 150), vy: bubblefxRnd(-90, -20), g: -40, life: bubblefxRnd(520, 760), fade: 0.6, delay: i * 120, s0: 0.5, s1: 2.3 });
    });
  },
  deflateExit(c) {
    c.style.transformOrigin = "100% 70%";
    c.animate([{ transform: "scale(.86,.8) rotate(5deg) translateY(10px)", opacity: 1 }, { transform: "scale(.8,.66) rotate(9deg) translateY(34px)", opacity: 0 }], { duration: 520, easing: "ease-in", fill: "forwards" })
      .finished.then(() => c.remove(), () => c.remove());
  },

  // Сердце — благодарность: короткая реплика превращается в сердце, оно бьётся двойным стуком, вверх летят сердечки.
  heart(run) {
    const { b, deco } = run;
    deco.innerHTML = BUBBLEFX_HEART;
    deco.style.setProperty("--hw", Math.max(132, Math.round(b.offsetWidth * 1.42)) + "px");
    run.later(450, () => {
      void deco.offsetWidth;
      b.classList.add("k-heart");
      wordfxTone({ f: 520, f2: 880, d: 0.16, type: "sine", g: 0.04 });
      run.later(520, () => {
        b.classList.add("beat");
        const beat = () => {
          if (run.calm) return;
          BUBBLEFX_SND.heart();
          const r = bubblefxRel(b);
          for (let i = 0; i < 2; i++) bubblefxFling(bubblefxEl("bfx-mini", `left:${r.x + bubblefxRnd(0.1, 0.9) * r.w}px;top:${r.y - 6}px`, bubblefxLayer(), BUBBLEFX_HMINI), { vx: bubblefxRnd(-28, 28), vy: bubblefxRnd(-70, -40), g: -60, spin: bubblefxRnd(-40, 40), life: bubblefxRnd(1100, 1500), fade: 0.5, s0: 0.5, s1: 1.1 });
          run.later(950, beat);
        };
        beat();
      });
    });
  },
  heartExit(c) {
    c.classList.remove("beat");
    c.animate([{ opacity: 1, transform: "translateY(-14px) scale(1)" }, { opacity: 0, transform: "translateY(-24px) scale(.7)" }], { duration: 420, easing: "ease-in", fill: "forwards" })
      .finished.then(() => c.remove(), () => c.remove());
  },

  // Цветы — похвала: по краю зеленоватого облачка растёт стебель, один за другим раскрываются восемь цветов, летят лепестки.
  bloom(run) {
    const { b, deco } = run;
    run.later(300, () => {
      deco.innerHTML = '<svg class="bfx-vinebox"><rect class="bfx-vine" pathLength="100"/></svg>';
      const pts = [[0.2, 0], [0.52, 0], [0.84, 0], [1, 0.45], [0.88, 1], [0.56, 1], [0.24, 1], [0, 0.55]];
      pts.forEach(([x, y], i) => {
        const d = 180 + i * 125, k = i % 3 === 1 ? 22 : 18;
        BUBBLEFX_SND.bell(i, d / 1000);
        bubblefxEl("bfx-flower", `left:${x * 100}%;top:${y * 100}%;width:${k}px;height:${k}px;margin:${-k / 2}px;animation-delay:${d}ms,${d + 500}ms`, deco, bubblefxFlower(i));
      });
      [[0.36, 0, 20], [0.68, 0, -30], [1, 0.75, 70], [0.72, 1, 200], [0.4, 1, 160], [0, 0.3, -70]].forEach(([x, y, a], i) => bubblefxEl("bfx-leaf", `left:${x * 100}%;top:${y * 100}%;rotate:${a}deg;animation-delay:${150 + i * 150}ms`, deco));
      const petal = () => {
        if (run.calm) return;
        const r = bubblefxRel(b), [x, y] = pts[Math.floor(Math.random() * pts.length)];
        bubblefxFling(bubblefxEl("bfx-petal", `left:${r.x + x * r.w}px;top:${r.y + y * r.h}px`, bubblefxLayer()), { vx: bubblefxRnd(-25, 45), vy: bubblefxRnd(0, 20), g: 90, spin: bubblefxRnd(-260, 260), life: bubblefxRnd(1500, 2100), fade: 0.4 });
        run.later(bubblefxRnd(160, 360), petal);
      };
      run.later(900, petal);
    });
  },
  bloomExit(c) {
    c.querySelectorAll(".bfx-flower").forEach((f, i) => f.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${bubblefxRnd(20, 80).toFixed(0)}px,${bubblefxRnd(-60, -10).toFixed(0)}px) rotate(${bubblefxRnd(120, 300).toFixed(0)}deg) scale(.5)`, opacity: 0 }], { duration: 650, delay: i * 40, easing: "ease-in", fill: "forwards" }));
    c.querySelectorAll(".bfx-vine, .bfx-leaf").forEach((e) => e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, fill: "forwards" }));
    c.animate([{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }], { duration: 900, fill: "forwards" }).finished.then(() => c.remove(), () => c.remove());
  },

  // Упала за панель — от большого удивления: бледнеет, заваливается назад и падает за край панели (её прячет сам край),
  // глухой стук, пыль, панель вздрагивает; через секунду из-за края показываются чепчик и глаза — и она вылезает обратно.
  fall(run) {
    const f = $("#face"), m = $("#maid");
    const anim = (kf, o) => { const a = f.animate(kf, { fill: "forwards", ...o }); run.anims.push(a); return a; };
    run.undo = () => { m.classList.remove("bfx-pale"); f.style.transformOrigin = ""; };
    run.later(350, () => {
      m.classList.add("bfx-pale");
      f.style.transformOrigin = "72% 100%";
      run.later(380, () => {
        anim([{ transform: "rotate(0)" }, { transform: "rotate(-3deg)", offset: 0.25 }, { transform: "rotate(15deg)" }], { duration: 460, easing: "cubic-bezier(.5,0,.9,.5)" });
        run.later(460, () => {
          BUBBLEFX_SND.slide();
          anim([{ transform: "rotate(15deg) translateY(0)" }, { transform: "rotate(24deg) translateY(118%)" }], { duration: 320, easing: "cubic-bezier(.6,0,1,.7)" });
          run.later(320, () => {
            const r = bubblefxRel(m), fl = bubblefxFloor(), w = collapsed ? $("#mini") : $("#w");
            BUBBLEFX_SND.thud();
            run.anims.push(w.animate([{ transform: "translateY(0)" }, { transform: "translateY(5px)" }, { transform: "translateY(-2px)" }, { transform: "translateY(1px)" }, { transform: "none" }], { duration: 420, easing: "ease-out" }));
            bubblefxDust(r.x + r.w * 0.45, fl - 3, 4, -1);
            bubblefxDust(r.x + r.w * 0.7, fl - 3, 4, 1);
            wordfxJolt(4);
            run.later(900, () => {
              m.classList.remove("bfx-pale");
              react("worried", 4500, true);
              f.style.transformOrigin = "";
              anim([{ transform: "translateY(118%)" }, { transform: "translateY(36%)" }], { duration: 560, easing: "cubic-bezier(.2,.8,.3,1)" });
              run.later(1250, () => {
                bubblefxMark("drop", 1900);
                anim([{ transform: "translateY(36%)" }, { transform: "translateY(-3%)", offset: 0.7 }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.3,1.4,.5,1)" });
                run.later(1700, () => { run.anims.forEach((a) => a.cancel()); run.anims = []; });
              });
            });
          });
        });
      });
    });
  },
};

/** Начать превращение (say(), когда текст допечатан). Падение за панель облачко не трогает — играет горничная. */
function bubblefxStart(kind) {
  bubblefxStop();
  const go = BUBBLEFX_KINDS[kind];
  const b = $("#bubble");
  if (!go || !b || b.classList.contains("hidden") || bubblefxCalm()) return;
  const run = (bubblefxRun = { kind, on: true, calm: false, timers: [], anims: [], b, shape: null, deco: null, exit: BUBBLEFX_KINDS[kind + "Exit"] ?? null, undo: null });
  run.later = (ms, fn) => run.timers.push(setTimeout(() => run.on && fn(), ms));
  if (kind !== "fall") {
    // Фон облачка уходит в отдельный слой (.bfx-shape): его можно гнуть, плавить и прятать, не трогая текст.
    b.classList.add("bfx");
    run.shape = bubblefxEl("bfx-shape");
    run.deco = bubblefxEl("bfx-deco");
    b.prepend(run.shape, run.deco);
  }
  go(run);
  run.later(BUBBLEFX_HOLD, () => (run.calm = true)); // повторы (капли, стук, лепестки) стихают — облачко стоит в новом виде
}
/** Облачко уходит (hideBubble): превращение доигрывает уход на копии облачка, само облачко гаснет сразу. */
function bubblefxExit() {
  const run = bubblefxRun, b = $("#bubble");
  if (run?.exit && b && !b.classList.contains("hidden") && !bubblefxCalm()) {
    const r = bubblefxRel(b), c = b.cloneNode(true);
    c.removeAttribute("id");
    c.querySelectorAll("[id]").forEach((e) => e.removeAttribute("id"));
    c.classList.add("bfx-ghost");
    c.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
    bubblefxLayer().append(c);
    b.classList.add("bfx-gone");
    run.exit(c, r);
  }
  bubblefxStop();
}
/** Снять превращение сразу (новая реплика, уход облачка). Класс bfx-gone снимает следующий say() вместе с остальными. */
function bubblefxStop() {
  const run = bubblefxRun;
  if (!run) return;
  bubblefxRun = null;
  run.on = false;
  run.timers.forEach(clearTimeout);
  run.anims.forEach((a) => a.cancel());
  run.undo?.();
  run.shape?.remove();
  run.deco?.remove();
  run.b.classList.remove("bfx", "k-melt", "k-flat", "k-heart", "beat");
}
