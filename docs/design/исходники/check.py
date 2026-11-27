"""Проверка фрагмента макета: python check.py parts/<ключ>.html"""
import re, sys, os, subprocess, tempfile

sys.stdout.reconfigure(encoding="utf-8")
path = sys.argv[1]
key = os.path.splitext(os.path.basename(path))[0]
src = open(path, encoding="utf-8").read()
errs, warns = [], []

if len(src.encode("utf-8")) > 80 * 1024:
    errs.append("файл больше 80 КБ: %d" % len(src.encode("utf-8")))
if "var(--fd)" in src:
    errs.append("var(--fd) (Unbounded) внутри макета: по дизайн-системе v3 только Onest, var(--f)")
if re.search(r"text-transform:\s*uppercase", src):
    warns.append("UPPERCASE: по дизайн-системе v3 капслок не используем")
if 'id="p-%s"' % key not in src:
    errs.append('нет <article class="piece" id="p-%s">' % key)
if src.count("<article") != 1 or src.count("</article>") != 1:
    errs.append("должен быть ровно один <article>…</article>")
for bad in ("localStorage", "sessionStorage", "<link", "http://", "https://", "@import", "alert(", "confirm(", "prompt("):
    if bad in src:
        errs.append("запрещено: %s" % bad)

styles = re.findall(r"<style>(.*?)</style>", src, re.S)
css = "\n".join(styles)
for m in re.finditer(r"#[0-9a-fA-F]{3,8}\b", css):
    errs.append("литеральный цвет в CSS: %s" % m.group(0))
if re.search(r"\brgba?\(", css) or re.search(r"\bhsla?\(", css):
    errs.append("rgb()/hsl() в CSS — используй токены или color-mix с токеном")
# литеральные цвета в разметке/скрипте (fill="#...", style="color:#...")
body = re.sub(r"<style>.*?</style>", "", src, flags=re.S)
for m in re.finditer(r"(?:fill|stroke|color|background)\s*[=:]\s*[\"']?\s*(#[0-9a-fA-F]{3,8})\b", body):
    errs.append("литеральный цвет в разметке/скрипте: %s" % m.group(1))
# селекторы
clean = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
for m in re.finditer(r"@keyframes\s+([\w-]+)", clean):
    if not m.group(1).startswith(key + "-"):
        errs.append("@keyframes без префикса %s-: %s" % (key, m.group(1)))
clean = re.sub(r"@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}", "", clean)
clean = re.sub(r"@(media|supports|container)[^{]*\{", "", clean)
for m in re.finditer(r"([^{}]+)\{", clean):
    sel = m.group(1).strip()
    if not sel or sel.startswith("@"):
        continue
    for part in sel.split(","):
        part = part.strip()
        if part and not part.startswith("#p-" + key):
            errs.append("селектор не начинается с #p-%s: %s" % (key, part[:70]))

scripts = re.findall(r"<script>(.*?)</script>", src, re.S)
if not scripts:
    warns.append("нет <script> — макет без поведения?")
for i, js in enumerate(scripts):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(js)
        tmp = f.name
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    os.unlink(tmp)
    if r.returncode != 0:
        errs.append("синтаксис скрипта %d: %s" % (i + 1, r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "ошибка"))
    if "replay" not in js:
        warns.append("скрипт не слушает событие replay")
    if "MaidMock" not in js:
        warns.append("скрипт не использует MaidMock.onSeen / MaidMock.reduce")
for m in re.finditer(r'\sid="([^"]+)"', src):
    v = m.group(1)
    if v != "p-" + key and not v.startswith(key + "-"):
        errs.append("id без префикса %s-: %s" % (key, v))
if 'class="replay"' not in src:
    warns.append("нет кнопки .replay")
if 'class="notes"' not in src:
    warns.append("нет блока .notes")

print("ОШИБКИ (%d):" % len(errs))
for e in dict.fromkeys(errs):
    print("  -", e)
print("ЗАМЕЧАНИЯ (%d):" % len(warns))
for w in dict.fromkeys(warns):
    print("  -", w)
print("OK" if not errs else "НЕ ПРОШЛО")
sys.exit(1 if errs else 0)
