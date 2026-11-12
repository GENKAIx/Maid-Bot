"""Выпуск новой версии программы на ПК: поднять номер, собрать установщик, выложить на сервер.

После выпуска кнопка «Обновить» в настройках (раздел «Виджет» → «Программа») скачает её и поставит сама.

    python tools/release-desktop.py            # 0.1.0 → 0.1.1
    python tools/release-desktop.py 0.2.0      # свой номер
    python tools/release-desktop.py --no-upload  # только собрать

Сервер отдаёт файлы из /data/desktop контейнера maid (server/src/api.ts, serveDesktop).
"""
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


def bump(v: str) -> str:
    a, b, c = (int(x) for x in v.split("."))
    return f"{a}.{b}.{c + 1}"


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    upload = "--no-upload" not in sys.argv
    pkg = json.loads(PKG.read_text(encoding="utf-8"))
    old = pkg["version"]
    new = args[0] if args else bump(old)
    if not re.fullmatch(r"\d+\.\d+\.\d+", new):
        sys.exit(f"Номер версии вида 1.2.3, а не «{new}»")
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
    print(f"Собрано: {exe} ({exe.stat().st_size // 1_000_000} МБ)")
    if not upload:
        return

    subprocess.run(SSH + [HOST, f"rm -rf {REMOTE} && mkdir -p {REMOTE}"], check=True)
    subprocess.run(["scp", *SSH[1:], str(exe), str(yml), f"{HOST}:{REMOTE}/"], check=True)
    # Старые версии убираем: на сервере лежит только последняя.
    subprocess.run(SSH + [HOST, f"chmod 644 {REMOTE}/* && cd /srv && docker compose exec -T maid rm -rf /data/desktop "
                                f"&& docker compose cp {REMOTE} maid:/data/desktop"], check=True)
    print(f"Выложено: версия {new}. В программе — «Проверить» в разделе «Программа».")


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
