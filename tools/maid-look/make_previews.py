"""Картинки «Перекрасить Рину» для сайта: первый кадр hello во всех цветах волос и глаз → web/public/maid/look.

КОГДА ПЕРЕЗАПУСКАТЬ: после подъёма LOOK_VERSION в desktop/renderer/look.js (другие числа ключей и целей в look_math.py),
после пересборки масок desktop/assets/maid-keep (make_masks.py) и после правки анимации hello.webp
в desktop/assets/maid. Скрипт пишет ещё web/public/maid/look/sources.json — LOOK_VERSION и sha256 анимаций и масок,
по которым сделаны картинки; тест desktop/test/look-ids.test.cjs сверяет его с файлами и с look.js (устарело — падает).

Что делает. Для каждой анимации из ANIMS берёт первый кадр исходника desktop/assets/maid/<анимация>.webp (400×427) и тот
же кадр маски «оставить свой цвет» desktop/assets/maid-keep/<анимация>.webp (альфа > 127 — оставить), перекрашивает его
look_math.recolour — те же числа и формулы, что у виджета (look.js, lookPixels), — для каждого сочетания волосы × глаза
(6 × 4) и уменьшает до SIZE: вдвое больше того, как картинку показывает страница «Настройки → Горничная»
(MaidSettings.tsx, 180×192), чтобы на экранах с плотными пикселями было чётко. Уменьшение — Lanczos (Pillow для RGBA
считает с предумноженной альфой — края не темнеют). Свои цвета (red × violet) — исходный кадр без перекраски: файл
пишется тоже, чтобы страница брала все картинки одинаково.

Файлы: web/public/maid/look/<анимация>-<волосы>-<глаза>.webp — WebP с потерями (QUALITY), альфа без потерь. Лишние
файлы в папке (цвет убрали из таблиц) удаляются. Результат одинаков от запуска к запуску (одни и те же входы и настройки
кодировщика). Печатает размер каждой анимации и общий — цель до 1,5 МБ на всё.

Запуск (Python 3.10, Pillow, numpy, scipy — как make_masks.py):
  python tools/maid-look/make_previews.py
"""
import hashlib
import io
import json
import os
import re
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import look_math as L  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
SRC = os.path.join(ROOT, 'desktop', 'assets', 'maid')
KEEP = os.path.join(ROOT, 'desktop', 'assets', 'maid-keep')
DST = os.path.join(ROOT, 'web', 'public', 'maid', 'look')
LOOK_JS = os.path.join(ROOT, 'desktop', 'renderer', 'look.js')

ANIMS = ('hello',)  # картинка страницы «Настройки → Горничная»; другие анимации — когда сайт начнёт их показывать
SIZE = (360, 384)  # 2 × 180×192 — размер показа на странице (и копий в web/public/maid)
QUALITY = 88
TARGET = 1.5 * 1024 * 1024  # байт на все картинки


def look_version():
    m = re.search(r'^const LOOK_VERSION = (\d+);', open(LOOK_JS, encoding='utf-8').read(), re.M)
    if not m:
        sys.exit(f'не нашлась строка const LOOK_VERSION = …; в {LOOK_JS}')
    return int(m.group(1))


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def first_frame(path):
    im = Image.open(path)
    im.seek(0)
    return np.asarray(im.convert('RGBA')).copy()


def encode(rgba):
    img = Image.fromarray(rgba, 'RGBA').resize(SIZE, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=QUALITY, alpha_quality=100, method=6, exact=False)
    return buf.getvalue()


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    os.makedirs(DST, exist_ok=True)
    written, total, sources = set(), 0, {}
    for anim in ANIMS:
        src = os.path.join(SRC, anim + '.webp')
        keep_path = os.path.join(KEEP, anim + '.webp')
        rgba = first_frame(src)
        km = first_frame(keep_path)
        if km.shape != rgba.shape:
            sys.exit(f'{anim}: маска {km.shape[1]}×{km.shape[0]}, кадр {rgba.shape[1]}×{rgba.shape[0]} — перезапусти make_masks.py')
        keep = km[..., 3] > 127
        size = 0
        for hair in L.HAIR:
            for eyes in L.EYES:
                same = L.HAIR[hair] is None and L.EYES[eyes] is None
                data = encode(rgba if same else L.recolour(rgba, hair, eyes, keep))
                name = f'{anim}-{hair}-{eyes}.webp'
                with open(os.path.join(DST, name), 'wb') as f:
                    f.write(data)
                written.add(name)
                size += len(data)
        total += size
        sources[anim + '.webp'] = dict(src=sha256(src), keep=sha256(keep_path))
        print(f'{anim:6s} {len(L.HAIR) * len(L.EYES)} картинок {SIZE[0]}×{SIZE[1]}, {size / 1024:6.1f} КБ')
    for f in sorted(os.listdir(DST)):
        if f.endswith('.webp') and f not in written:
            os.remove(os.path.join(DST, f))
            print('удалён лишний', f)
    doc = dict(about='Пишет tools/maid-look/make_previews.py, руками не править: LOOK_VERSION из desktop/renderer/look.js и '
                     'sha256 исходной анимации (src) и её маски (keep), по которым сделаны картинки этой папки.',
               version=look_version(), size=list(SIZE), quality=QUALITY, files=sources)
    with open(os.path.join(DST, 'sources.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'всего {len(written)} картинок, {total / 1024 / 1024:.2f} МБ'
          + ('' if total <= TARGET else f' — больше цели {TARGET / 1024 / 1024:.1f} МБ: снизь QUALITY или SIZE'))


if __name__ == '__main__':
    main()
