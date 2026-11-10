# Резерв проекта в папку РЕЗЕРВ: на случай, если пропадёт папка, git или история чата.
# Запуск: python tools/backup.py — копирует только изменившееся, ничего в резерве не удаляет.
#   РЕЗЕРВ/проект/  — рабочая папка как есть (с незакоммиченным и файлами вне git), без node_modules, сборок, .env и secrets/
#   РЕЗЕРВ/git/     — maid-bot.bundle: вся история git одним файлом
#   РЕЗЕРВ/чат/     — разговоры с Claude Code по этому проекту (.jsonl и их папки) и память Claude
#   РЕЗЕРВ/СОСТОЯНИЕ.md — когда сделан, последний коммит, что не закоммичено
import datetime
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "РЕЗЕРВ")
CLAUDE = os.path.join(os.path.expanduser("~"), ".claude", "projects")
# Разговор считается разговором этого проекта, если путь проекта в нём встречается часто (сессии запускались из E:\CastleBattle2).
MARK = "Горничная бот".encode("utf-8")
MARK_MIN = 50

# Не копировать: зависимости и сборки (восстанавливаются npm install / сборкой), сам резерв и ключи.
SKIP_DIRS = {"node_modules", "dist", "build", "out-tsc", ".git", "РЕЗЕРВ", "secrets", "__pycache__"}
def skip_file(name):
    return name == ".env" or (name.startswith(".env.") and name != ".env.example")

copied = 0
def sync(src, dst):
    """Копировать файл, если его нет или он изменился (размер или время)."""
    global copied
    try:
        s = os.stat(src)
    except OSError:
        return
    if os.path.exists(dst):
        d = os.stat(dst)
        if d.st_size == s.st_size and int(d.st_mtime) >= int(s.st_mtime):
            return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    copied += 1

def sync_tree(src, dst, skip_dirs=frozenset()):
    for base, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        rel = os.path.relpath(base, src)
        for f in files:
            if skip_file(f):
                continue
            sync(os.path.join(base, f), os.path.normpath(os.path.join(dst, rel, f)))

def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8").stdout.strip()

def project_chats():
    out = []
    for proj in os.listdir(CLAUDE):
        folder = os.path.join(CLAUDE, proj)
        if not os.path.isdir(folder):
            continue
        for f in os.listdir(folder):
            if not f.endswith(".jsonl"):
                continue
            n = 0
            with open(os.path.join(folder, f), "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 22), b""):
                    n += chunk.count(MARK)
                    if n >= MARK_MIN:
                        out.append((proj, f[:-6]))
                        break
    return out

def main():
    os.makedirs(DEST, exist_ok=True)
    # 1. Рабочая папка.
    sync_tree(ROOT, os.path.join(DEST, "проект"), SKIP_DIRS)
    # 2. Вся история git.
    os.makedirs(os.path.join(DEST, "git"), exist_ok=True)
    subprocess.run(["git", "bundle", "create", os.path.join(DEST, "git", "maid-bot.bundle"), "--all"], cwd=ROOT,
                   capture_output=True, check=True)
    # 3. Разговоры и память Claude.
    chats = project_chats()
    for proj, sid in chats:
        sync(os.path.join(CLAUDE, proj, sid + ".jsonl"), os.path.join(DEST, "чат", proj, sid + ".jsonl"))
        if os.path.isdir(os.path.join(CLAUDE, proj, sid)):
            sync_tree(os.path.join(CLAUDE, proj, sid), os.path.join(DEST, "чат", proj, sid))
    for proj in {p for p, _ in chats}:
        mem = os.path.join(CLAUDE, proj, "memory")
        if os.path.isdir(mem):
            sync_tree(mem, os.path.join(DEST, "чат", proj, "memory"))
    # 4. Состояние.
    now = datetime.datetime.now().strftime("%d.%m.%Y %H:%M")
    status = git("status", "--short") or "всё закоммичено"
    with open(os.path.join(DEST, "СОСТОЯНИЕ.md"), "w", encoding="utf-8") as fh:
        fh.write(f"# Резерв «Горничная бот»\n\nСделан: {now}\n\nВетка: {git('branch', '--show-current')}\n\n"
                 f"Последние коммиты:\n```\n{git('log', '--oneline', '-10')}\n```\n\nНе закоммичено:\n```\n{status}\n```\n\n"
                 f"Разговоров с Claude: {len(chats)}\n")
    shutil.copy2(os.path.join(ROOT, "tools", "backup.README.md"), os.path.join(DEST, "README.md"))
    print(f"резерв: {now}, скопировано файлов: {copied}, разговоров: {len(chats)}")

if __name__ == "__main__":
    sys.exit(main())
