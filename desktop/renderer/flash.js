// Окно вспышки (main.js, memFlash) — весь экран. go(x, y) — щелчок нейралайзера из точки (x, y) окна.
// Блики-«зайчики» ложатся на линию от линзы через середину экрана, как в объективе камеры.
const GHOSTS = [
  { t: 0.45, r: 26, c: "rgba(140, 200, 255, .5)" },
  { t: 0.8, r: 70, c: "rgba(120, 255, 210, .22)" },
  { t: 1.15, r: 14, c: "rgba(255, 210, 140, .55)" },
  { t: 1.4, r: 120, c: "rgba(160, 140, 255, .16)" },
  { t: 1.75, r: 40, c: "rgba(255, 170, 120, .3)" },
];
window.go = (x, y) => {
  const fx = document.getElementById("fx");
  fx.style.setProperty("--x", `${Math.round(x)}px`);
  fx.style.setProperty("--y", `${Math.round(y)}px`);
  const box = fx.querySelector(".ghosts");
  box.replaceChildren();
  const cx = innerWidth / 2, cy = innerHeight / 2;
  for (const g of GHOSTS) {
    const el = document.createElement("i");
    el.className = "ghost";
    // Строгая политика окна не пускает style в разметке — место, размер и цвет через CSSOM.
    Object.assign(el.style, {
      left: `${(cx - x) * g.t}px`, top: `${(cy - y) * g.t}px`, width: `${g.r * 2}px`, height: `${g.r * 2}px`,
      background: `radial-gradient(circle, rgba(255, 255, 255, 0) 40%, ${g.c} 78%, rgba(255, 255, 255, 0) 100%)`,
    });
    box.append(el);
  }
  fx.classList.remove("on");
  void fx.offsetWidth;
  fx.classList.add("on");
};
