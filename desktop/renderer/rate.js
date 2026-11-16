// Оценка дня звёздами: что происходит после щелчка по звезде (widget.js зовёт rateShow из обработчика кнопок облачка).
// Сначала звёзды до выбранной зажигаются по одной, каждая со своим «поп» на полтона выше — счёт слышно. Дальше по ступени:
//   1–3  — звёзды гаснут и осыпаются вниз, горничная грустит;
//   4–6  — звёзды один раз подпрыгивают на месте, она кланяется;
//   7–8  — звёзды летят к ней дугой, она радуется;
//   9    — то же, она гордится;
//   10   — звёзды летят к ней, и сверху по всему окну сыплется звездопад, она в восторге.
// Летящие звёзды — копии поверх окна (position: fixed), клики сквозь них проходят. Грузится до widget.js.

const RATE_STEP = 75; // пауза между зажигающимися звёздами, мс
const rateMood = (v) => (v <= 3 ? "sad" : v <= 6 ? "bow" : v <= 8 ? "happy" : v === 9 ? "proud" : "excited");
const rateWait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Копия звезды поверх окна на месте rect; дальше её двигает анимация. */
function rateClone(rect) {
  const s = document.createElement("img");
  s.className = "rate-fly";
  s.src = "../assets/star.png";
  s.alt = "";
  s.style.left = `${rect.left}px`;
  s.style.top = `${rect.top}px`;
  s.style.width = `${rect.width}px`;
  s.style.height = `${rect.height}px`;
  document.body.appendChild(s);
  return s;
}
function rateFly(el, frames, opts) {
  return el.animate(frames, { fill: "forwards", ...opts }).finished.catch(() => {}).then(() => el.remove());
}

/** Показать оценку v (1–10) на ряду звёзд облачка; обещание выполняется, когда всё долетело. */
async function rateShow(v) {
  const acts = $("#bubbleActions");
  const stars = [...acts.querySelectorAll(".rate-star")].slice(0, v);
  react(rateMood(v), 5000);
  if (!stars.length) return;
  acts.classList.add("rated"); // наведение больше не перекрашивает ряд, повторный щелчок не пройдёт
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    stars.forEach((s) => s.classList.add("on"));
    return rateWait(600);
  }
  for (const [i, s] of stars.entries()) {
    s.classList.add("on");
    popTone(i, { vol: 0.22, soft: true });
    await rateWait(RATE_STEP);
  }
  await rateWait(220);

  const jobs = [];
  if (v <= 3) {
    // Плохой день: звёзды гаснут и осыпаются.
    popTone(-9, { vol: 0.2, soft: true });
    stars.forEach((s, i) => {
      const c = rateClone(s.querySelector("img").getBoundingClientRect());
      s.classList.remove("on");
      jobs.push(rateFly(c, [
        { transform: "translate(0, 0) rotate(0deg)", filter: "grayscale(0)", opacity: 1 },
        { transform: `translate(${(i - 1) * 9}px, 70px) rotate(${60 + i * 35}deg)`, filter: "grayscale(1)", opacity: 0 },
      ], { duration: 900, delay: i * 110, easing: "cubic-bezier(.5, 0, .9, .6)" }));
    });
  } else if (v <= 6) {
    // Обычный день: звёзды один раз подпрыгивают на месте.
    stars.forEach((s, i) => jobs.push(s.querySelector("img").animate(
      [{ translate: "0 0" }, { translate: "0 -7px" }, { translate: "0 0" }],
      { duration: 380, delay: i * 45, easing: "ease-out" },
    ).finished.catch(() => {})));
  } else {
    // Хороший день: звёзды летят к горничной дугой.
    const face = $("#face").getBoundingClientRect();
    const to = { x: face.left + face.width / 2, y: face.top + face.height * 0.42 };
    stars.forEach((s, i) => {
      const r = s.querySelector("img").getBoundingClientRect();
      const c = rateClone(r);
      s.classList.remove("on"); // со своего места звезда улетела
      const dx = to.x - (r.left + r.width / 2);
      const dy = to.y - (r.top + r.height / 2);
      const lift = 46 + (i % 3) * 16;
      jobs.push(rateFly(c, [
        { transform: "translate(0, 0) scale(1) rotate(0deg)", opacity: 1 },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - lift}px) scale(1.35) rotate(180deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy}px) scale(.3) rotate(360deg)`, opacity: 0 },
      ], { duration: 820, delay: i * 60, easing: "cubic-bezier(.3, .1, .3, 1)" }).then(() => popTone(8 + (i % 5), { vol: 0.12, soft: true })));
    });
    if (v === 10) {
      // Идеальный день: звездопад сверху по всей ширине окна.
      for (let i = 0; i < 26; i++) {
        const size = 12 + Math.random() * 16;
        const c = rateClone({ left: Math.random() * (innerWidth - size), top: -30, width: size, height: size });
        jobs.push(rateFly(c, [
          { transform: "translate(0, 0) rotate(0deg)", opacity: 0 },
          { opacity: 1, offset: 0.12 },
          { transform: `translate(${Math.random() * 80 - 40}px, ${innerHeight * (0.55 + Math.random() * 0.4)}px) rotate(${Math.random() * 540 - 270}deg)`, opacity: 0 },
        ], { duration: 1500 + Math.random() * 900, delay: 300 + Math.random() * 900, easing: "cubic-bezier(.3, 0, .7, 1)" }));
      }
    }
  }
  await Promise.all(jobs);
}
