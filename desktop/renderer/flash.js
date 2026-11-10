// Окно вспышки (main.js, memFlash) — один монитор целиком. go(x, y) — щелчок нейралайзера из точки (x, y) окна
// (на других мониторах точка за краем окна: видна засветка и полоса на той же высоте).
window.go = (x, y) => {
  const fx = document.getElementById("fx");
  fx.style.setProperty("--x", `${Math.round(x)}px`);
  fx.style.setProperty("--y", `${Math.round(y)}px`);
  fx.classList.remove("on");
  void fx.offsetWidth;
  fx.classList.add("on");
};
