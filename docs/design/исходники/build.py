"""Сборка ревью: python build.py → review.html (для Artifact) и test.html (для локальной проверки)."""
import re, os, sys
sys.stdout.reconfigure(encoding="utf-8")
here = os.path.dirname(os.path.abspath(__file__))
rd = lambda n: open(os.path.join(here, n), encoding="utf-8").read()

def parts(m):
    out = []
    for key in m.group(1).split(","):
        p = os.path.join(here, "parts", key.strip() + ".html")
        if os.path.exists(p):
            out.append(open(p, encoding="utf-8").read())
        else:
            out.append('<article class="piece"><header><h2>Макет «%s» не готов</h2></header></article>' % key)
            print("НЕТ ФРАГМЕНТА:", key)
    return "\n".join(out)

head = """<title>Горничная: большое ревью</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700;800&family=Unbounded:wght@600;700;800&display=swap">
"""
body = head + "<style>\n" + rd("shared.css") + "\n" + rd("page.css") + "\n</style>\n<script>\n" + rd("shared.js") + "\n</script>\n"
for ch in ("ch-head.html", "ch-design.html", "ch-weak.html", "ch-tariffs.html", "ch-admin.html", "ch-plan.html"):
    body += re.sub(r"<!--PARTS:([^>]*?)-->", parts, rd(ch)) + "\n"
open(os.path.join(here, "review.html"), "w", encoding="utf-8").write(body)
open(os.path.join(here, "test.html"), "w", encoding="utf-8").write('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>' + body)
print("review.html: %d КБ" % (len(body.encode("utf-8")) // 1024))
