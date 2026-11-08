import { useEffect, useState } from "react";

// Маршруты по адресу страницы: /, /diary, /diary/2026-11-08, /habits, /habits/2026-11.
// Сервер на любой такой адрес отдаёт index.html.

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
}

export function navigate(to: string, replace = false) {
  if (to === location.pathname) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function parsePath(path: string): { tab: string; arg?: string } {
  const [, tab = "", arg] = path.split("/");
  return { tab: tab || "today", arg: arg || undefined };
}
