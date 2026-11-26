"""Выпуск новой версии программы на ПК: поднять номер, собрать установщик, выложить на сервер.

После выпуска кнопка «Обновить» в настройках (раздел «Виджет» → «Программа») скачает её и поставит сама.

    python tools/release-desktop.py --notes "пункт 1 | пункт 2 | пункт 3"   # 0.1.0 → 0.1.1, сразу всем
    python tools/release-desktop.py 0.2.0 --notes-file заметки.txt         # свой номер; заметки — пункт на строку
    python tools/release-desktop.py --no-upload                            # только собрать
    python tools/release-desktop.py --percent=20 --notes "…"               # поэтапно: начать с 20% (только если владелец просит)

По умолчанию выпуск идёт сразу всем (stagingPercentage 100) — решение владельца 26.11.2026: «делай всегда для 100%, если только я
не прошу об обратном». Поэтапно — только с явным --percent=N (N меньше 100).

«Что нового» (--notes "а | б | в" или --notes-file путь: UTF-8, пункт на строку, «- » в начале можно): 3–7 коротких строк простыми
словами для владельца, не больше 12, пункт до 200 знаков, без HTML. Кладутся рядом с latest.yml файлом notes-<версия>.json; сервер,
впервые увидев версию, переносит их в историю выпусков (админка «Выпуски» → «Что нового», server/src/releases.ts). Без заметок выпуск
всё равно идёт, но скрипт предупреждает.

Сервер отдаёт файлы из /data/desktop контейнера maid (server/src/api.ts, serveDesktop; notes-*.json наружу не отдаются).

Доля выпуска (server/src/releases.ts): сервер, увидев новую версию, берёт stagingPercentage из latest.yml; дальше процент и паузу меняют
в админке «Выпуски» (файл на диске не трогается: процент подставляется при отдаче). Если падений больше, чем у прошлой версии, выпуск сам
встаёт на паузу.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop"
PKG = DESKTOP / "package.json"
SSH = ["ssh", "-i", str(Path.home() / ".ssh" / "maid_vps"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=20"]
HOST = "root@187.126.11.122"
REMOTE = "/srv/desktop-release"
START_PERCENT = 100  # server/src/releases.ts RELEASE_START_PERCENT
NOTES_MAX_ITEMS = 12  # server/src/releases.ts NOTES_MAX_ITEMS
NOTE_MAX_LEN = 200  # server/src/releases.ts NOTE_MAX_LEN
HTML_TAG = re.compile(r"<[a-z!/?]", re.I)
CWD = Path.cwd()  # до os.chdir(ROOT): --notes-file считается от папки, где запустили


def bump(v: str) -> str:
    a, b, c = (int(x) for x in v.split("."))
    return f"{a}.{b}.{c + 1}"


def with_staging(yml: str, percent: int) -> str:
    """latest.yml со строкой stagingPercentage (прежняя убирается). 100 тоже пишется явно — так видно, что выпуск всем намеренно;
    при отдаче строку 100 сервер сам убирает (server/src/releases.ts servedPercent)."""
    lines = [x for x in yml.splitlines() if not x.startswith("stagingPercentage:")]
    lines.append(f"stagingPercentage: {percent}")
    return "\n".join(lines) + "\n"


def percent_type(v: str) -> int:
    if not v.isdigit() or not 1 <= int(v) <= 100:
        raise argparse.ArgumentTypeError(f"--percent — целое от 1 до 100, а не «{v}»")
    return int(v)


def clean_notes(lines: list[str]) -> list[str]:
    """Пункты: пробелы по краям и «- »/«• »/«* » в начале убираются, пустые строки выбрасываются. Не годятся — SystemExit с причиной
    (те же пределы, что на сервере, server/src/releases.ts cleanNotes)."""
    notes = [re.sub(r"^\s*(?:[-•*]\s+)?", "", x).strip() for x in lines]
    notes = [x for x in notes if x]
    if len(notes) > NOTES_MAX_ITEMS:
        sys.exit(f"Заметок — не больше {NOTES_MAX_ITEMS} пунктов, а их {len(notes)}")
    for i, x in enumerate(notes, 1):
        if len(x) > NOTE_MAX_LEN:
            sys.exit(f"Пункт {i} длиннее {NOTE_MAX_LEN} знаков ({len(x)})")
        if HTML_TAG.search(x):
            sys.exit(f"Пункт {i}: без HTML, только простой текст")
    return notes


def read_notes(notes: str | None, notes_file: str | None) -> list[str]:
    """--notes "а | б" (пункты через «|») или --notes-file (UTF-8, пункт на строку); оба сразу — ошибка; ни одного — пустой список."""
    if notes is not None and notes_file is not None:
        sys.exit("Заметки — либо --notes, либо --notes-file, не оба сразу")
    if notes_file is not None:
        p = Path(notes_file) if Path(notes_file).is_absolute() else CWD / notes_file
        if not p.is_file():
            sys.exit(f"Нет файла заметок «{notes_file}»")
        return clean_notes(p.read_text(encoding="utf-8-sig").splitlines())
    return clean_notes(notes.split("|")) if notes is not None else []


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="release-desktop.py", description="Выпуск программы на ПК (по умолчанию — сразу всем).")
    ap.add_argument("version", nargs="?", help="номер вида 1.2.3; без него — следующий после нынешнего")
    ap.add_argument("--no-upload", action="store_true", help="только собрать, на сервер не класть")
    ap.add_argument("--percent", type=percent_type, default=START_PERCENT,
                    help="доля людей в начале выпуска, 1…100; по умолчанию 100 — сразу всем; меньше — только если владелец просит")
    ap.add_argument("--notes", help="«что нового»: пункты через «|»")
    ap.add_argument("--notes-file", help="«что нового»: файл UTF-8, пункт на строку")
    a = ap.parse_args(argv)
    a.notes_list = read_notes(a.notes, a.notes_file)
    return a


def notes_json(version: str, notes: list[str]) -> str:
    """Содержимое notes-<версия>.json (его читает сервер: server/src/releases.ts notesFile)."""
    return json.dumps({"version": version, "notes": notes}, ensure_ascii=False, indent=1) + "\n"


def notes_warning(notes: list[str]) -> str | None:
    if not notes:
        return "ВНИМАНИЕ: выпуск без «что нового» (--notes или --notes-file) — в админке «Выпуски» будет пусто, допишите там."
    if not 3 <= len(notes) <= 7:
        return f"Заметок {len(notes)}: лучше 3–7 коротких пунктов."
    return None


def main() -> None:
    a = parse_args(sys.argv[1:])
    percent, notes = a.percent, a.notes_list
    pkg = json.loads(PKG.read_text(encoding="utf-8"))
    old = pkg["version"]
    new = a.version or bump(old)
    if not re.fullmatch(r"\d+\.\d+\.\d+", new):
        sys.exit(f"Номер версии вида 1.2.3, а не «{new}»")
    warn = notes_warning(notes)
    if warn:
        print(warn)
    # Номер правим строкой — остальной файл не переформатируется.
    text = PKG.read_text(encoding="utf-8")
    PKG.write_text(text.replace(f'"version": "{old}"', f'"version": "{new}"', 1), encoding="utf-8")
    print(f"Версия {old} → {new}")

    # electron-builder не работает из папки с русским именем — через диск M:, как build-installer.cmd.
    subprocess.run(["subst", "M:", str(ROOT)], check=False)
    try:
        subprocess.run("npx electron-builder --win nsis", cwd="M:\\desktop", shell=True, check=True)
    finally:
        subprocess.run(["subst", "M:", "/d"], check=False)

    dist = DESKTOP / "dist"
    exe = dist / f"Gornichnaya-Setup-{new}.exe"
    yml = dist / "latest.yml"
    if not exe.exists() or not yml.exists():
        sys.exit(f"Нет {exe.name} или latest.yml в {dist}")
    if f"version: {new}" not in yml.read_text(encoding="utf-8"):
        sys.exit("latest.yml не от этой сборки")
    yml.write_bytes(with_staging(yml.read_text(encoding="utf-8"), percent).encode("utf-8"))
    files = [str(exe), str(yml)]
    if notes:
        nf = dist / f"notes-{new}.json"
        nf.write_bytes(notes_json(new, notes).encode("utf-8"))
        files.append(str(nf))
        print("Что нового:\n" + "\n".join(f"  — {x}" for x in notes))
    print(f"Выпуск: {'сразу всем' if percent >= 100 else f'поэтапно, начнём с {percent}% (дальше — админка «Выпуски»)'}")
    print(f"Собрано: {exe} ({exe.stat().st_size // 1_000_000} МБ)")
    if not a.no_upload:
        subprocess.run(SSH + [HOST, f"rm -rf {REMOTE} && mkdir -p {REMOTE}"], check=True)
        subprocess.run(["scp", *SSH[1:], *files, f"{HOST}:{REMOTE}/"], check=True)
        # Старые версии убираем: на сервере лежит только последняя (заметки прошлых уже в истории на сервере).
        subprocess.run(SSH + [HOST, f"chmod 644 {REMOTE}/* && cd /srv && docker compose exec -T maid rm -rf /data/desktop "
                                    f"&& docker compose cp {REMOTE} maid:/data/desktop"], check=True)
        print(f"Выложено: версия {new}. В программе — «Проверить» в разделе «Программа».")
    if warn and not notes:
        print(warn)  # ещё раз в конце, чтобы не потерялось в выводе сборки


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # консоль Windows в cp1251 не печатает «→»
    os.chdir(ROOT)
    main()
