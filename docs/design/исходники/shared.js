/* Общий скрипт ревью: строит рамку окна вокруг каждого <div class="app" data-hub data-tab data-title>,
   даёт макетам MaidMock.onSeen / MaidMock.reduce и событие "replay" на .piece (кнопка .replay). */
(function () {
  "use strict";
  var ICON = {
    today: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    plans: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
    diary: '<path d="M6 4h11a1 1 0 0 1 1 1v15H7a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1z"/><path d="M9 9h6M9 13h4"/>',
    stats: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    rina: '<path d="M12 20s-7-4.4-7-9.5A4 4 0 0 1 12 8a4 4 0 0 1 7 2.5C19 15.600 12 20 12 20z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.600 5.600l2 2M16.400 16.400l2 2M5.600 18.400l2-2M16.400 7.600l2-2"/>'
  };
  var HUBS = [["today", "Сегодня"], ["plans", "Планы"], ["diary", "Дневник"], ["stats", "Обзор"], ["rina", "Рина"]];
  var TABS = {
    today: [],
    plans: ["Неделя", "Привычки", "Задачи", "Даты"],
    diary: ["Дни", "Заметки", "История"],
    stats: ["Итоги", "Сон", "Компьютер", "Деньги", "Здоровье"],
    rina: ["Характер и вид", "О вас", "Альбом"],
    gear: ["Программа", "Виджет", "Корзина"]
  };
  function svg(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + "</svg>"; }
  function decorate(app) {
    if (app.dataset.built) return; app.dataset.built = "1";
    var hub = app.dataset.hub || "today", tab = app.dataset.tab || "", title = app.dataset.title || "";
    var content = document.createElement("div"); content.className = "app-content";
    while (app.firstChild) content.appendChild(app.firstChild);
    var rail = document.createElement("nav"); rail.className = "app-rail"; rail.setAttribute("aria-label", "Разделы программы");
    rail.innerHTML = '<div class="me"><img src="maid/idle.webp" alt=""></div>' + HUBS.map(function (h) {
      return '<a href="#" class="' + (h[0] === hub ? "on" : "") + '" tabindex="-1" onclick="return false">' + svg(h[0]) + h[1] + "</a>";
    }).join("") + '<div class="sp"></div><a href="#" class="' + (hub === "gear" ? "on" : "") + '" tabindex="-1" onclick="return false">' + svg("gear") + "Настройки</a>";
    var body = document.createElement("div"); body.className = "app-body";
    var top = document.createElement("header"); top.className = "app-top";
    top.innerHTML = "<h3>" + title + "</h3>" + (TABS[hub] && TABS[hub].length ? '<div class="app-tabs">' + TABS[hub].map(function (t) { return '<span class="' + (t === tab ? "on" : "") + '">' + t + "</span>"; }).join("") + "</div>" : "") +
      '<div class="app-find"><span>Найти или сказать Рине…</span><kbd>Ctrl K</kbd></div>';
    body.appendChild(top); body.appendChild(content);
    app.appendChild(rail); app.appendChild(body);
  }
  var ADM = [["Обзор", ["Обзор", "Аналитика"]], ["Люди и деньги", ["Пользователи", "Оплаты", "Тарифы", "Аудитория"]], ["ИИ", ["Расходы на модель", "Качество разбора"]], ["Продукт", ["Функции", "Переключатели"]], ["Связь", ["Обращения", "Объявления"]], ["Система", ["Здоровье сервера", "Оповещения", "Выпуски", "Копии базы"]]];
  function decorateAdm(adm) {
    if (adm.dataset.built) return; adm.dataset.built = "1";
    var sec = adm.dataset.section || "", grp = adm.dataset.group || "Система";
    var main = document.createElement("div"); main.className = "adm-main";
    var h = document.createElement("h3"); h.textContent = sec; main.appendChild(h);
    while (adm.firstChild) main.appendChild(adm.firstChild);
    var side = document.createElement("div"); side.className = "adm-side";
    side.innerHTML = "<b>Горничная · админка</b>" + ADM.map(function (g) {
      return "<small>" + g[0] + "</small>" + g[1].map(function (x) { return "<span>" + x + "</span>"; }).join("") + (g[0] === grp ? '<span class="on new">' + sec + "</span>" : "");
    }).join("");
    adm.appendChild(side); adm.appendChild(main);
  }
  /* картинка Рины не загрузилась — круг с буквой рядом, картинка прячется; загрузится позже — вернётся */
  document.addEventListener("error", function (e) {
    var im = e.target;
    if (!im || im.tagName !== "IMG" || !im.parentNode) return;
    if (!im.previousSibling || !im.previousSibling.classList || !im.previousSibling.classList.contains("rina-fb")) {
      var d = document.createElement("span");
      d.className = "rina-fb"; d.textContent = "Р"; d.setAttribute("aria-hidden", "true");
      var w = +(im.getAttribute("width") || 0) || im.clientWidth || 48, h = +(im.getAttribute("height") || 0) || im.clientHeight || w;
      d.style.width = Math.min(w, h, 64) + "px"; d.style.height = Math.min(w, h, 64) + "px";
      im.parentNode.insertBefore(d, im);
    }
    im.style.display = "none";
  }, true);
  document.addEventListener("load", function (e) {
    var im = e.target;
    if (!im || im.tagName !== "IMG" || im.style.display !== "none") return;
    im.style.display = "";
    var p = im.previousSibling; if (p && p.classList && p.classList.contains("rina-fb")) p.remove();
  }, true);
  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.MaidMock = {
    reduce: reduce,
    /* вызвать fn один раз, когда элемент показался на экране (или сразу, если наблюдатель недоступен) */
    onSeen: function (el, fn) {
      if (!("IntersectionObserver" in window)) { fn(); return; }
      var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { io.disconnect(); fn(); } }); }, { threshold: .25 });
      io.observe(el);
    },
    decorateAll: function () { document.querySelectorAll(".app[data-hub]").forEach(decorate); document.querySelectorAll(".adm[data-section]").forEach(decorateAdm); }
  };
  document.addEventListener("click", function (e) {
    var b = e.target.closest(".replay"); if (!b) return;
    var p = b.closest(".piece"); if (p) p.dispatchEvent(new CustomEvent("replay"));
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", window.MaidMock.decorateAll); else window.MaidMock.decorateAll();
})();
