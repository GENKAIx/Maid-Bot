"""Сборка страницы дизайна: python build_design.py <версия> → design-v<версия>.html (для Artifact) и test-design.html (локально).
Изменения версии берутся из changes-v<версия>.html (список <li>), если файл есть."""
import re, os, sys
sys.stdout.reconfigure(encoding="utf-8")
here = os.path.dirname(os.path.abspath(__file__))
rd = lambda n: open(os.path.join(here, n), encoding="utf-8").read()
ver = sys.argv[1] if len(sys.argv) > 1 else "1"
date = sys.argv[2] if len(sys.argv) > 2 else "27 ноября 2026"

def parts(m):
    out = []
    for key in m.group(1).split(","):
        p = os.path.join(here, "parts", key.strip() + ".html")
        out.append(open(p, encoding="utf-8").read() if os.path.exists(p) else '<article class="piece"><header><h2>Макет «%s» не готов</h2></header></article>' % key)
    return "\n".join(out)

ch = os.path.join(here, "changes-v%s.html" % ver)
changes = ('<div class="callout"><b>Что изменилось в этой версии</b><ul>' + rd("changes-v%s.html" % ver) + "</ul></div>") if os.path.exists(ch) else ""
head = """<title>Горничная: дизайн</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700;800&family=Unbounded:wght@600;700;800&display=swap">
"""
design = rd("ch-design.html")
design = re.sub(r'<p class="eyebrow">Глава 1</p>', '<p class="eyebrow">Дизайн полной версии · версия %s · %s</p>' % (ver, date), design)
design = design.replace("</div>\n  <div class=\"principles\">", changes + "</div>\n  <div class=\"principles\">", 1)
top = """<div class="page">
<nav class="chapters" aria-label="Вид">
  <span class="skin" style="margin-left:0">Макеты программы: <button type="button" id="skin-dark" aria-pressed="true">Тёмные</button><button type="button" id="skin-light" aria-pressed="false">Светлые</button></span>
</nav>
"""
script = """</div>
<script>
(function () {
  "use strict";
  var d = document.getElementById("skin-dark"), l = document.getElementById("skin-light");
  function skin(v) { if (v === "light") document.body.dataset.skin = "light"; else delete document.body.dataset.skin; d.setAttribute("aria-pressed", String(v !== "light")); l.setAttribute("aria-pressed", String(v === "light")); }
  d.addEventListener("click", function () { skin("dark"); }); l.addEventListener("click", function () { skin("light"); });
  var toc = document.getElementById("toc-design");
  document.querySelectorAll("#ch-design .piece").forEach(function (p) {
    var h = p.querySelector("header h2"), app = p.querySelector(".app[data-title]"), a = document.createElement("a");
    a.href = "#"; a.textContent = p.id === "p-d-nav" ? "Навигация и поиск" : p.id === "p-d-widget" ? "Виджет" : /^p-d-buffs-/.test(p.id) ? "Бафы: " + h.textContent : (app ? app.dataset.title : h.textContent);
    a.addEventListener("click", function (e) { e.preventDefault(); p.scrollIntoView({ block: "start", behavior: MaidMock.reduce ? "auto" : "smooth" }); });
    toc.appendChild(a);
  });
})();
</script>
"""
body = head + "<style>\n" + rd("shared.css") + "\n" + rd("page.css") + "\n</style>\n<script>\n" + rd("shared.js") + "\n</script>\n" + top + re.sub(r"<!--PARTS:([^>]*?)-->", parts, design) + script
open(os.path.join(here, "design-v%s.html" % ver), "w", encoding="utf-8").write(body)
open(os.path.join(here, "test-design.html"), "w", encoding="utf-8").write('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>' + body)
print("design-v%s.html: %d КБ" % (ver, len(body.encode("utf-8")) // 1024))
