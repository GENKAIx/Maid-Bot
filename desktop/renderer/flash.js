// Окно вспышки (main.js, memFlash): go(x, y) — свет из точки (x, y) окна, та же картинка и анимация, что .mem-flash в виджете.
window.go = (x, y) => {
  const f = document.getElementById("flash");
  f.style.setProperty("--fx", `${Math.round(x)}px`);
  f.style.setProperty("--fy", `${Math.round(y)}px`);
  f.classList.remove("on");
  void f.offsetWidth;
  f.classList.add("on");
};
