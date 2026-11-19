"""Цветовая математика «Перекрасить Рину» — эталон на Python для desktop/renderer/look.js.

Числа и формулы здесь и в look.js одни и те же (таблицы HAIR / EYES = LOOK_HAIR / LOOK_EYES). Поменял одно — поменяй
другое и подними LOOK_VERSION в look.js; тест desktop/test/look.test.cjs сверяет look.js с этим файлом на настоящем кадре.

Ключ: пиксель «волосы», если его тон близко к 349° (тёмно-красный), насыщенность и яркость в своих рамках; «глаза» — тон
около 283° (фиолетовый). Вес ключа w от 0 до 1 (мягкие края), новый цвет: тон цели + 0,3·(отклонение тона от центра ключа),
насыщенность и яркость — по правилу цели; итог = смесь (исходный, новый, w) в RGB, прозрачность не трогается.

Отдельный вызов для теста (без сети, только файлы):
  python tools/maid-look/look_math.py --dump <анимация.webp> <кадр> <маска.webp|-> <волосы> <глаза> <папка>
пишет в папку кадр сырыми байтами RGBA: in.raw (до), keep.raw (кадр маски, если она дана), out.raw (после перекраски),
и печатает «ширина высота».
"""
import sys

import numpy as np
from scipy import ndimage as ndi

# Ключи: центр тона, полуширина ядра, мягкий край (градусы); пороги насыщенности и яркости (от, до) — линейный подъём.
HAIR_KEY = dict(center=349, half=12, feather=8, s=(0.30, 0.42), v=(0.08, 0.16), vu=(0.90, 0.97))  # vu: светлое (румянец, сердечки, язык) — не волосы
EYE_KEY = dict(center=283, half=18, feather=12, s=(0.22, 0.32), v=(0.16, 0.26), vu=None)  # строгая яркость: не задеть фиолетовый оттенок чёрного контура
HUE_KEEP = 0.3  # доля отклонения тона от центра ключа, которая остаётся у нового цвета (живые блики и тени)

# Цели: h — новый тон; s — множитель насыщенности; v — правило яркости:
#   ('mul', k) — v·k;  ('pow', p) — 1 − (1 − v)^p (светлее);  ('lin', a, k) — a + k·v (сжатие в тёмное).
# None — исходный цвет, перекраски нет.
HAIR = {
    'red': None,
    'brown': dict(h=24, s=0.85, v=('mul', 0.72)),
    'gold': dict(h=42, s=0.95, v=('pow', 2.2)),
    'silver': dict(h=220, s=0.12, v=('pow', 1.75)),
    'violet': dict(h=282, s=0.85, v=('mul', 1.0)),
    'black': dict(h=235, s=0.35, v=('lin', 0.16, 0.42)),
}
EYES = {
    'violet': None,
    'green': dict(h=135, s=1.0, v=('mul', 1.0)),
    'blue': dict(h=212, s=1.0, v=('mul', 1.0)),
    'amber': dict(h=36, s=1.05, v=('pow', 1.74)),
}

# Правило «кольца»: куски ключа волос (w > 0,35, 8-связность) оставляем волосами, если кусок большой или его кольцо
# в 2 пикселя снаружи не больше чем на 45 % светлое (кожа, белое, бумага) или прозрачное. Иначе это рисунок на коже
# (складки, линия улыбки, рот, цветочки) — он остаётся исходного цвета.
RING_W = 0.35
RING_BIG = 3000
RING_LIGHT_SHARE = 0.45
RING_LIGHT_S = 0.38
RING_LIGHT_V = 0.80


def rgb2hsv(rgb):
    """RGB 0–255 → тон 0–360, насыщенность и яркость 0–1 (float64)."""
    rgb = rgb.astype(np.float64) / 255.0
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    m = d > 1e-9
    rm = m & (mx == r)
    gm = m & (mx == g) & ~rm
    bm = m & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = ((b - r)[gm] / d[gm]) + 2
    h[bm] = ((r - g)[bm] / d[bm]) + 4
    h = h * 60.0
    s = np.where(mx > 1e-9, d / np.maximum(mx, 1e-9), 0)
    return h, s, mx


def hsv2rgb(h, s, v):
    h = (h % 360) / 60.0
    i = np.floor(h).astype(np.int32) % 6
    f = h - np.floor(h)
    p = v * (1 - s)
    q = v * (1 - s * f)
    t = v * (1 - s * (1 - f))
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], -1)


def ramp(x, a, b):
    return np.clip((x - a) / (b - a), 0, 1)


def hue_win(h, center, half, feather):
    d = np.abs(((h - center + 180) % 360) - 180)
    return np.clip(1 - (d - half) / feather, 0, 1)


def key_weight(h, s, v, k):
    w = hue_win(h, k['center'], k['half'], k['feather']) * ramp(s, *k['s']) * ramp(v, *k['v'])
    if k['vu']:
        w = w * (1 - ramp(v, *k['vu']))
    return w


def remap(rgb, h, s, v, w, t, src_center):
    """Смесь исходного RGB (float) с цветом цели t по весу w."""
    if t is None or not w.any():
        return rgb
    dh = ((h - src_center + 180) % 360) - 180
    nh = (t['h'] + dh * HUE_KEEP) % 360
    ns = np.clip(s * t['s'], 0, 1)
    rule = t['v']
    if rule[0] == 'mul':
        nv = np.clip(v * rule[1], 0, 1)
    elif rule[0] == 'pow':
        nv = 1 - (1 - v) ** rule[1]
    else:
        nv = np.clip(rule[1] + rule[2] * v, 0, 1)
    out = hsv2rgb(nh, ns, nv) * 255
    return rgb * (1 - w[..., None]) + out * w[..., None]


def recolour(rgba, hair='red', eyes='violet', keep=None):
    """Кадр RGBA uint8 → перекрашенный кадр. keep — bool-маска «оставить исходный цвет» или None."""
    h, s, v = rgb2hsv(rgba[..., :3])
    wh = key_weight(h, s, v, HAIR_KEY)
    we = key_weight(h, s, v, EYE_KEY)
    vis = rgba[..., 3] > 0  # полностью прозрачное не трогаем (как look.js)
    if keep is not None:
        vis = vis & ~keep
    wh = wh * vis
    we = we * vis
    rgb = rgba[..., :3].astype(np.float64)
    out = remap(rgb, h, s, v, wh, HAIR[hair], HAIR_KEY['center'])
    out = remap(out, h, s, v, we, EYES[eyes], EYE_KEY['center'])
    res = rgba.copy()
    res[..., :3] = np.floor(np.clip(out + 0.5, 0, 255)).astype(np.uint8)
    return res


def ring_components(rgba, wh, s, v, cut=None):
    """Куски ключа волос и решение правила кольца: (метки, площади, оставить_как_волосы[k], доля_светлого[k]).
    cut — bool-растр «вырезать» (фигуры C из make_masks.py) или None: его пиксели ни в какой кусок не входят, так вещь,
    коснувшаяся пряди, не срастается с большим куском волос."""
    al = rgba[..., 3]
    b = (wh > RING_W) & (al > 128)
    if cut is not None:
        b &= ~cut
    lab, n = ndi.label(b, np.ones((3, 3)))
    keep = np.zeros(n + 1, bool)
    area = np.zeros(n + 1, np.int64)
    light_share = np.zeros(n + 1)
    if n == 0:
        return lab, area, keep, light_share
    light = ((s < RING_LIGHT_S) & (v > RING_LIGHT_V)) | (al <= 128)
    for k, sl in enumerate(ndi.find_objects(lab), 1):
        y0 = max(sl[0].start - 3, 0)
        y1 = min(sl[0].stop + 3, b.shape[0])
        x0 = max(sl[1].start - 3, 0)
        x1 = min(sl[1].stop + 3, b.shape[1])
        c = lab[y0:y1, x0:x1] == k
        ring = ndi.binary_dilation(c, iterations=2) & ~c
        lf = light[y0:y1, x0:x1][ring].mean() if ring.any() else 0.0
        area[k] = int(c.sum())
        light_share[k] = lf
        keep[k] = area[k] >= RING_BIG or lf < RING_LIGHT_SHARE
    return lab, area, keep, light_share


def _dump(argv):
    """--dump: кадр до и после перекраски сырыми байтами RGBA (для сверки look.js с эталоном)."""
    import os
    from PIL import Image
    src, idx, keep_path, hair, eyes, out_dir = argv
    im = Image.open(src)
    im.seek(int(idx))
    rgba = np.asarray(im.convert('RGBA')).copy()
    keep = None
    if keep_path != '-':
        km = Image.open(keep_path)
        km.seek(int(idx))
        kr = np.asarray(km.convert('RGBA'))
        keep = kr[..., 3] > 127
        open(os.path.join(out_dir, 'keep.raw'), 'wb').write(kr.tobytes())
    res = recolour(rgba, hair, eyes, keep)
    open(os.path.join(out_dir, 'in.raw'), 'wb').write(rgba.tobytes())
    open(os.path.join(out_dir, 'out.raw'), 'wb').write(res.tobytes())
    print(rgba.shape[1], rgba.shape[0])


if __name__ == '__main__':
    if len(sys.argv) == 8 and sys.argv[1] == '--dump':
        _dump(sys.argv[2:])
    else:
        print(__doc__)
        sys.exit(2)
