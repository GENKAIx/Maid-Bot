// Тема оформления на этом устройстве: светлая, тёмная или как в системе. Хранится в localStorage,
// ставится атрибутом data-theme на <html> (цвета — в styles.css). index.html ставит её до загрузки, чтобы не мигало.

export type Theme = "light" | "dark" | "system";
const KEY = "maid.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export const getTheme = (): Theme => {
  const t = localStorage.getItem(KEY);
  return t === "dark" || t === "system" ? t : "light";
};

function apply() {
  const t = getTheme();
  const dark = t === "dark" || (t === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#15121f" : "#f4f3f8");
}

export function setTheme(t: Theme) {
  localStorage.setItem(KEY, t);
  apply();
}

export function initTheme() {
  apply();
  media.addEventListener("change", apply);
}
