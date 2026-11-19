"""Маски «оставить свой цвет» для перекраски Рины: desktop/assets/maid/<имя>.webp → desktop/assets/maid-keep/<имя>.webp.

КОГДА ПЕРЕЗАПУСКАТЬ: после любой правки анимаций в desktop/assets/maid (новая анимация, перерисованная, другое число
кадров или длительности), после правки SHAPES ниже или ключа волос в look_math.py и после подъёма LOOK_VERSION в
desktop/renderer/look.js. Маска должна совпадать с анимацией кадр в кадр.

Скрипт пишет ещё desktop/assets/maid-keep/sources.json: sha256 каждой анимации и её маски и LOOK_VERSION, для которой
маски сделаны. Тест desktop/test/look.test.cjs сверяет его с файлами и с look.js — так ловится и перерисованная анимация
с теми же длительностями, и маска, поменявшаяся без подъёма версии.
Поменялись маски — подними LOOK_VERSION в look.js (иначе виджет покажет старую перекраску из кэша) и запусти снова: пока
версия та же, что в sources.json, скрипт маски пишет (чтобы посмотреть листы), а sources.json — нет, и выходит с ошибкой.
Листы (--sheets) посмотреть глазами.

Зачем маска. Ключ волос (look_math.HAIR_KEY) ловит по цвету всё тёмно-красное: кроме волос это знак злости, сердечки,
рот, складки на груди, линии на ладонях, брови и линии век. Маска отмечает пиксели, которые ключ поймал бы, но они должны
остаться своего цвета. Кадр маски: белый непрозрачный = оставить исходный цвет, прозрачный = перекрашивать по ключу.

Как строится кадр маски:
 0) фигуры C «вырезать» из таблицы SHAPES: их пиксели ни в какой кусок не входят и все остаются своего цвета. Это для
    вещей, которые на части кадров касаются пряди и по ключу срастаются с большим куском волос (цветок у пряди, бровь,
    линия века) — без выреза такая вещь мигала бы: срослась — перекрашена, отошла — своего цвета;
 1) правило кольца (look_math.ring_components): кусок ключа (w > 0,35, 8-связность) — волосы, если он больше 3000 px
    или его кольцо в 2 px снаружи светлое (кожа, белое, бумага) или прозрачное меньше чем на 45 %;
 2) голосование по анимации: мелкий кусок (< 3000 px) решается суммой голосов всех кадров в его пикселях («тут был
    кусок-волосы» минус «тут был снятый кусок»). Без этого одна и та же складка или прядь на коже мигала бы от кадра к
    кадру то своим цветом, то новым (кольцо на грани 45 %). При равенстве голосов — правило кольца;
 3) поверх — ручная таблица SHAPES ниже (фигуры на нужных кадрах): R/P «снять» — куски ключа, целиком лежащие внутри
    фигуры и меньше 3000 px, остаются своего цвета; H «волосы» — такие куски перекрашиваются, даже если их сняли
    кольцо, голосование или R. «Волосы» главнее: H — узкая фигура на конкретных кадрах внутри широкой R (кончик пряди
    у ресниц). Волосы, заходящие в фигуру краем, — часть большого куска и не задеваются;
 4) маска = (вес ключа > 0) и не ближе 2 px к оставшимся кускам волос; затем расширение на 1 px (кроме зоны волос и
    пикселей ключа глаз: маска отменяет и перекраску глаз, край радужки у ресниц остался бы фиолетовым) — запас на
    разницу декодеров (Pillow и Chromium); плюс всё из фигур C;
 5) проверка мигания (flicker): кусок ключа, оставленный маской своего цвета (от 20 px), не должен на соседнем кадре
    быть перекрашен на половину и больше. Нашлось — список кадров, sources.json не пишется, выход с ошибкой; лечится
    фигурой C (вещь касается волос) или H (это волосы).

Файл маски — анимированный WebP без потерь, те же размер холста, число кадров, длительности и повтор, что у анимации;
каждый кадр — целый холст (смещение 0, без смешивания). Собирается своим кодом (mux_anim), а не save_all у Pillow:
тот склеивает одинаковые соседние кадры в один, и число кадров разошлось бы с анимацией.

Запуск (Python 3.10, Pillow, numpy, scipy):
  python tools/maid-look/make_masks.py                      — все маски и sources.json
  python tools/maid-look/make_masks.py angry letter         — только эти анимации (в sources.json — только их строки)
  python tools/maid-look/make_masks.py --sheets <папка>     — ещё листы для проверки глазами (папка вне репозитория):
      по каждой анимации два-три худших кадра (больше всего мелких кусков, оставленных волосами; больше всего снятого
      маской; мигание, если есть), столбцы: исходник, золотистые, серебристые, чёрные (глаза свои), зелёные глаза
      (волосы свои), разметка (синее — волосы, зелёное — мелкие куски волос, красное — маска, пурпурное — снято
      фигурами R/P, голубое — вырезано фигурами C, оранжевое — решение поменяло голосование).
  python tools/maid-look/make_masks.py --check [имена]      — проверка уже записанных масок (для теста): печатает JSON
      {имя: {"flicker": [...], "eye": пикселей маски на ключе глаз}}; ничего не пишет.
"""
import hashlib
import io
import json
import os
import re
import struct
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import look_math as L  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
SRC = os.path.join(ROOT, 'desktop', 'assets', 'maid')
DST = os.path.join(ROOT, 'desktop', 'assets', 'maid-keep')
MANIFEST = os.path.join(DST, 'sources.json')
LOOK_JS = os.path.join(ROOT, 'desktop', 'renderer', 'look.js')

FLICKER_MIN = 20  # px: кусок меньше не проверяется на мигание
FLICKER_SHARE = 0.5  # мигает, если на соседнем кадре перекрашена такая доля куска или больше


def R(x0, y0, x1, y1, f=None, kind='drop'):
    """«Снять»: прямоугольник [x0, x1) × [y0, y1) в пикселях холста 400×427; f — (первый, последний) кадр
    включительно или None (все кадры)."""
    return dict(poly=[(x0, y0), (x1 - 1, y0), (x1 - 1, y1 - 1), (x0, y1 - 1)], f=f, kind=kind)


def H(x0, y0, x1, y1, f=None):
    """«Волосы»: куски внутри прямоугольника — волосы, даже если правило кольца их сняло (прядь поперёк лица)."""
    return R(x0, y0, x1, y1, f, 'hair')


def C(x0, y0, x1, y1, f=None):
    """«Вырезать»: все пиксели ключа в прямоугольнике остаются своего цвета, даже когда вещь касается пряди и по ключу
    срастается с большим куском волос. Настоящих волос в фигуре на этих кадрах быть не должно — фигура тесная."""
    return R(x0, y0, x1, y1, f, 'cut')


def P(points, f=None, kind='drop'):
    """Многоугольник по точкам (x, y); f — как у R, kind — 'drop' (как R), 'hair' (как H) или 'cut' (как C)."""
    return dict(poly=list(points), f=f, kind=kind)


# Что правило кольца пропускает и что снимается с волос вручную (найдено по листам 20.11.2026). Координаты R/H — с запасом
# на покачивание: снимаются только куски, целиком лежащие в фигуре, поэтому волосы, заходящие в неё, не страдают.
# Фигуры C режут по пикселям, поэтому они тесные и только на кадрах, где вещь касается волос (проверка мигания).
SHAPES = {
    'angry': [R(28, 137, 100, 214),          # знак злости слева от головы
              R(233, 204, 254, 226)],        # нижнее веко
    'bedtime': [R(56, 242, 103, 292),        # облачко-завиток слева
                R(212, 249, 248, 271),       # рот
                R(212, 272, 235, 291),       # бант на шее
                R(192, 286, 225, 336)],      # складки на груди
    'bow': [R(194, 295, 230, 348)],          # складки на груди и пальцы
    'clean': [R(59, 257, 82, 281), R(76, 245, 113, 297), R(106, 318, 130, 347)],  # ручка метёлки
    'excited': [R(187, 212, 229, 255)],      # кайма рта
    'forget': [R(149, 301, 175, 338),        # складка на груди
               R(180, 172, 210, 192),        # бровь
               P([(178, 176), (199, 176), (199, 177), (201, 179), (201, 182), (199, 183), (178, 183)], kind='cut')],
    # ↑ бровь правым концом уходит под контур пряди и на половине кадров срастается с волосами
    'gasp': [R(198, 228, 223, 261)],         # рот
    'giggle': [R(143, 190, 207, 229), R(224, 191, 262, 225),  # ресницы зажмуренных глаз
               # линии век касаются прядей: левая — кончиком у пряди справа от неё, правая — у пряди слева
               P([(169, 185), (181, 185), (187, 189), (187, 194), (186, 195), (186, 197), (169, 191)], kind='cut'),
               C(236, 199, 250, 215)],
    'letter': [R(187, 337, 243, 384)],       # сердечко на конверте
    'listen': [R(257, 306, 283, 336)],       # складка на груди
    'neutral': [R(195, 231, 234, 269)],      # кайма рта
    'pout': [H(150, 148, 190, 189),          # прядь поперёк лба (кольцо — кожа, но это волосы)
             R(161, 289, 184, 313)],         # складка на груди
    'present': [R(40, 259, 84, 285)],        # линии ладони
    'proud': [R(194, 302, 227, 344)],        # складки на груди и пальцы
    'refuse': [R(186, 204, 218, 232), R(236, 197, 269, 220),  # ресницы
               R(41, 335, 66, 368), R(388, 278, 400, 313)],    # линии взмаха
    'salute': [R(86, 144, 132, 196)],        # линии ладони
    'shy': [R(195, 255, 226, 273),           # рот
            H(264, 237, 280, 250)],          # кончик контура пряди на щеке (почти на всех кадрах — с волосами)
    'sleep': [R(259, 310, 280, 337)],        # складка на груди
    'smitten': [R(24, 115, 96, 183), R(39, 177, 87, 223)],  # края сердечек
    'streak': [R(190, 221, 240, 273),        # открытый рот
               R(29, 140, 102, 223)],        # огонёк
    'tea': [R(140, 190, 205, 222), R(230, 190, 300, 228),   # ресницы
            R(197, 223, 230, 251),           # губы над чашкой
            R(150, 260, 300, 335),           # контур рук, чашки и складки на груди
            R(200, 255, 256, 280),           # кайма чашки (бывает выше 260; правее x 256 — прядь в тени, не трогать)
            C(158, 250, 173, 286),           # контур кисти у чашки: заходит выше 260, R его не берёт
            C(52, 143, 93, 192, f=(25, 32)),  # цветок слева касается пряди
            # нижний край ресниц правого глаза касается волос справа, левый конец — пряди слева
            P([(242, 202), (279, 202), (279, 211), (282, 212), (282, 224), (242, 224)], kind='cut'),
            C(152, 209, 186, 218, f=(30, 30)),  # нижний край ресниц левого глаза касается волос слева
            C(153, 199, 186, 208, f=(73, 73)),  # то же выше (глаз поднят)
            H(190, 199, 200, 208, f=(19, 19)),  # кончик пряди у правого края левого глаза: на соседних кадрах
            H(184, 201, 199, 209, f=(24, 24))],  # он с волосами, тут отделился и попал в R ресниц
    'think2': [R(251, 293, 273, 320)],       # складка на груди
    'write': [R(201, 315, 225, 343)],        # складка на груди
}


# --- RIFF/WebP: разбор и сборка (то же, что lookWebpChunks / lookMuxAnim в desktop/renderer/look.js) ---

def riff_chunks(b, at, end):
    out = []
    while at + 8 <= end:
        t = b[at:at + 4].decode('latin-1')
        n = struct.unpack('<I', b[at + 4:at + 8])[0]
        out.append((t, b[at + 8:at + 8 + n]))
        at += 8 + n + (n & 1)
    return out


def anim_info(path):
    """Холст, повтор и длительности кадров исходной анимации — прямо из ANIM/ANMF."""
    b = open(path, 'rb').read()
    assert b[:4] == b'RIFF' and b[8:12] == b'WEBP', path
    info = dict(width=None, height=None, loop=0, durations=[])
    for t, d in riff_chunks(b, 12, min(len(b), 8 + struct.unpack('<I', b[4:8])[0])):
        if t == 'VP8X':
            info['width'] = int.from_bytes(d[4:7], 'little') + 1
            info['height'] = int.from_bytes(d[7:10], 'little') + 1
        elif t == 'ANIM':
            info['loop'] = struct.unpack('<H', d[4:6])[0]
        elif t == 'ANMF':
            info['durations'].append(int.from_bytes(d[12:15], 'little'))
    return info


def chunk(t, payload):
    return t.encode('latin-1') + struct.pack('<I', len(payload)) + payload + (b'\0' if len(payload) & 1 else b'')


def still_parts(webp):
    """Куски кадра (ALPH, VP8 , VP8L) и размер картинки из одиночного WebP."""
    top = riff_chunks(webp, 12, len(webp))
    parts = [(t, d) for t, d in top if t in ('ALPH', 'VP8 ', 'VP8L')]
    for t, d in parts:
        if t == 'VP8L':
            bits = int.from_bytes(d[1:5], 'little')
            return parts, (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if t == 'VP8 ':
            return parts, struct.unpack('<H', d[6:8])[0] & 0x3FFF, struct.unpack('<H', d[8:10])[0] & 0x3FFF
    raise ValueError('в кадре нет VP8/VP8L')


def mux_anim(width, height, loop, bgcolor, frames):
    """Анимированный WebP из одиночных: frames = [(байты WebP, длительность мс)], кадры целым холстом, без смешивания."""
    body = [chunk('VP8X', bytes([0x12, 0, 0, 0]) + (width - 1).to_bytes(3, 'little') + (height - 1).to_bytes(3, 'little')),
            chunk('ANIM', struct.pack('<IH', bgcolor, loop))]
    for webp, dur in frames:
        parts, w, h = still_parts(webp)
        head = (0).to_bytes(3, 'little') * 2 + (w - 1).to_bytes(3, 'little') + (h - 1).to_bytes(3, 'little') \
            + int(dur).to_bytes(3, 'little') + bytes([0x02])  # 0x02: не смешивать с прошлым кадром, не стирать
        body.append(chunk('ANMF', head + b''.join(chunk(t, d) for t, d in parts)))
    data = b'WEBP' + b''.join(body)
    return b'RIFF' + struct.pack('<I', len(data)) + data


# --- маска кадра ---

def shape_masks(name, n_frames, size):
    """Фигуры SHAPES по кадрам: [(куски, вырез)], где куски — [(растр bool HxW, это_волосы)] (сначала «снять», потом
    «волосы» — последняя подходящая фигура решает) или None, вырез — объединённый растр фигур C на этом кадре или None."""
    w, h = size
    shapes = SHAPES.get(name, [])
    out = []
    for i in range(n_frames):
        live = [s for s in shapes if s['f'] is None or s['f'][0] <= i <= s['f'][1]]
        parts = sorted((s for s in live if s['kind'] != 'cut'), key=lambda s: s['kind'] == 'hair')
        cuts = [_raster(s['poly'], w, h) for s in live if s['kind'] == 'cut']
        out.append(([(_raster(s['poly'], w, h), s['kind'] == 'hair') for s in parts] or None,
                    np.logical_or.reduce(cuts) if cuts else None))
    return out


_RASTER = {}


def _raster(poly, w, h):
    key = (tuple(poly), w, h)
    if key not in _RASTER:
        im = Image.new('1', (w, h), 0)
        ImageDraw.Draw(im).polygon(poly, fill=1, outline=1)
        _RASTER[key] = np.asarray(im, dtype=bool)
    return _RASTER[key]


def frame_ring(rgba, cut=None):
    """Ключи и правило кольца для кадра: (вес ключа волос, вес ключа глаз, метки кусков, площади, волосы_по_кольцу[k],
    доля светлого[k]). cut — растр фигур C или None."""
    h, s, v = L.rgb2hsv(rgba[..., :3])
    wh = L.key_weight(h, s, v, L.HAIR_KEY)
    we = L.key_weight(h, s, v, L.EYE_KEY)
    lab, area, keep, light = L.ring_components(rgba, wh, s, v, cut)
    return wh, we, lab, area, keep, light


def add_votes(votes, lab, area, keep):
    """Голоса кадра: в каждом пикселе — сколько кадров тут был мелкий кусок-волосы и сколько снятый кольцом."""
    hair_v, drop_v = votes
    b = lab > 0
    small = keep[lab] & (area[lab] < L.RING_BIG)
    hair_v += b & small
    drop_v += b & ~keep[lab]


def frame_mask(wh, we, lab, area, keep, shapes, cut, votes):
    """Решение по кускам кадра и маска. Мелкий кусок (< 3000 px) решается голосованием по всей анимации: сумма голосов
    «волосы» минус «снят» по его пикселям (так кусок не мигает то своим цветом, то новым от кадра к кадру); при
    равенстве — правило кольца. Затем фигуры SHAPES: кусок целиком внутри «снять» — свой цвет, внутри «волос» — волосы
    («волосы» главнее); всё в вырезе cut — свой цвет. Возвращает (маска bool, волосы[k], снято_фигурой[k],
    изменено_голосованием[k])."""
    keep = keep.copy()
    by_shape = np.zeros_like(keep)
    by_vote = np.zeros_like(keep)
    hair_v, drop_v = votes
    for k, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None or area[k] >= L.RING_BIG:
            continue
        c = lab[sl] == k
        score = int(hair_v[sl][c].sum()) - int(drop_v[sl][c].sum())
        if score and (score > 0) != keep[k]:
            keep[k] = score > 0
            by_vote[k] = True
        for m, hair in shapes or ():
            if m[sl][c].all():
                keep[k] = hair
                by_shape[k] = not hair
                by_vote[k] = False
    hair = ndi.binary_dilation(keep[lab], iterations=2)
    eye = we > 0
    m = (wh > 0) & ~hair
    m = ndi.binary_dilation(m) & ~hair & ~eye
    if cut is not None:
        m |= cut & ndi.binary_dilation(wh > 0) & ~eye
    return m, keep, by_shape, by_vote


def flicker(cores, masks, loop):
    """Мигание: куски ключа (w > 0,35, непрозрачные), оставленные маской своего цвета, от FLICKER_MIN px, которые на
    соседнем кадре перекрашены на FLICKER_SHARE и больше (у бесконечной анимации, loop = 0, соседи по кругу — первый и
    последний кадр). cores и masks — bool-растры кадров. Возвращает [(кадр, соседний кадр, площадь, из неё перекрашено
    там, [x0, y0, x1, y1])]."""
    n = len(cores)
    out = []
    for f in range(n):
        lab, _ = ndi.label(cores[f] & masks[f], np.ones((3, 3)))
        for k, sl in enumerate(ndi.find_objects(lab), 1):
            c = lab[sl] == k
            a = int(c.sum())
            if a < FLICKER_MIN:
                continue
            for g in (f - 1, f + 1):
                if not 0 <= g < n:
                    if loop:
                        continue
                    g %= n
                over = int((c & cores[g][sl] & ~masks[g][sl]).sum())
                if over >= FLICKER_SHARE * a:
                    out.append((f, g, a, over, [sl[1].start, sl[0].start, sl[1].stop, sl[0].stop]))
    return out


def encode_mask(m):
    a = np.zeros(m.shape + (4,), np.uint8)
    a[m] = 255
    buf = io.BytesIO()
    Image.fromarray(a, 'RGBA').save(buf, 'WEBP', lossless=True, quality=100, method=6, exact=False)
    return buf.getvalue()


def frames_of(im):
    for i in range(im.n_frames):
        im.seek(i)
        yield i, np.asarray(im.convert('RGBA'))


def anim_votes(im, shapes):
    """Первый проход: правило кольца по всем кадрам и голоса. Возвращает (голоса, [(метки, площади, кольцо, светлое)])."""
    votes = (np.zeros(im.size[::-1], np.int32), np.zeros(im.size[::-1], np.int32))
    rings = []
    for i, rgba in frames_of(im):
        _, _, lab, area, keep, light = frame_ring(rgba, shapes[i][1])
        add_votes(votes, lab, area, keep)
        rings.append((lab, area, keep, light))
    return votes, rings


def compute(name):
    """Маски одной анимации в памяти: (сведения из anim_info, маски кадров, статистика для листов, голоса, мигание)."""
    src = os.path.join(SRC, name + '.webp')
    info = anim_info(src)
    im = Image.open(src)
    n = im.n_frames
    assert n == len(info['durations']) and im.size == (info['width'], info['height']), name
    shapes = shape_masks(name, n, im.size)
    votes, rings = anim_votes(im, shapes)
    stats, masks, cores = [], [], []
    for i, rgba in frames_of(im):
        lab, area, ring_keep, light = rings[i]
        h, s, v = L.rgb2hsv(rgba[..., :3])
        wh = L.key_weight(h, s, v, L.HAIR_KEY)
        we = L.key_weight(h, s, v, L.EYE_KEY)
        parts, cut = shapes[i]
        m, keep, by_shape, by_vote = frame_mask(wh, we, lab, area, ring_keep, parts, cut, votes)
        assert not (m & (we > 0)).any(), f'{name}: кадр {i} — маска на ключе глаз'
        core = (wh > L.RING_W) & (rgba[..., 3] > 128)
        # «подозрительные» мелкие куски волос: кольцо хоть немного светлое — на коже или бумаге, а не среди волос
        sus = keep & (area < L.RING_BIG) & (light >= 0.15)
        stats.append(dict(suspect=int(area[sus].sum()), dropped=int((m & (wh > L.RING_W)).sum()),
                          by_shape=int(area[by_shape].sum()), by_vote=int(area[by_vote].sum()),
                          by_cut=int((m & core & cut).sum()) if cut is not None else 0,
                          by_shape_max=int(area[by_shape].max()) if by_shape.any() else 0, keep=int(m.sum())))
        masks.append(m)
        cores.append(core)
    return info, masks, stats, votes, flicker(cores, masks, info['loop'])


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def build(name):
    """Маска одной анимации: пишет файл, проверяет его. Возвращает (имя, кадров, байт, статистика, голоса, мигание,
    sha256 исходника, sha256 маски)."""
    src = os.path.join(SRC, name + '.webp')
    info, masks, stats, votes, fl = compute(name)
    n = len(masks)
    frames = [(encode_mask(m), info['durations'][i]) for i, m in enumerate(masks)]
    data = mux_anim(info['width'], info['height'], info['loop'], 0, frames)
    out = os.path.join(DST, name + '.webp')
    with open(out, 'wb') as f:
        f.write(data)
    # Проверка записанного: Pillow открывает, кадров и длительностей столько же, альфа = маска.
    chk = Image.open(out)
    assert chk.n_frames == n and chk.size == (info['width'], info['height']), f'{name}: кадров {chk.n_frames} из {n}'
    back = anim_info(out)
    assert back['durations'] == info['durations'] and back['loop'] == info['loop'], name
    for i, a in frames_of(chk):
        assert np.array_equal(a[..., 3] > 127, masks[i]), f'{name}: кадр {i} маски не совпал после записи'
    return name, n, len(data), stats, votes, fl, sha256(src), hashlib.sha256(data).hexdigest()


def check_files(name):
    """--check: мигание и пиксели маски на ключе глаз по уже записанным файлам (исходник + маска из maid-keep)."""
    src = os.path.join(SRC, name + '.webp')
    im = Image.open(src)
    km = Image.open(os.path.join(DST, name + '.webp'))
    assert km.n_frames == im.n_frames, f'{name}: в маске {km.n_frames} кадров из {im.n_frames}'
    cores, masks, eye = [], [], 0
    for i, rgba in frames_of(im):
        km.seek(i)
        m = np.asarray(km.convert('RGBA'))[..., 3] > 127
        h, s, v = L.rgb2hsv(rgba[..., :3])
        cores.append((L.key_weight(h, s, v, L.HAIR_KEY) > L.RING_W) & (rgba[..., 3] > 128))
        masks.append(m)
        eye += int((m & (L.key_weight(h, s, v, L.EYE_KEY) > 0)).sum())
    return name, flicker(cores, masks, anim_info(src)['loop']), eye


# --- sources.json: какие анимации и для какой LOOK_VERSION сделаны маски ---

def look_version():
    m = re.search(r'^const LOOK_VERSION = (\d+);', open(LOOK_JS, encoding='utf-8').read(), re.M)
    if not m:
        sys.exit(f'не нашлась строка const LOOK_VERSION = …; в {LOOK_JS}')
    return int(m.group(1))


def read_manifest():
    if not os.path.exists(MANIFEST):
        return None
    with open(MANIFEST, encoding='utf-8') as f:
        return json.load(f)


def write_manifest(version, files):
    doc = dict(about='Пишет tools/maid-look/make_masks.py, руками не править: sha256 исходной анимации (src) и её маски '
                     '(keep) и LOOK_VERSION из desktop/renderer/look.js, для которой маски сделаны.',
               version=version, files={k: files[k] for k in sorted(files)})
    with open(MANIFEST, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write('\n')


def outside_repo(path):
    """Папка для листов не в репозитории: не сам его корень и не внутри него."""
    p = os.path.normcase(os.path.realpath(path))
    r = os.path.normcase(os.path.realpath(ROOT))
    return p != r and not p.startswith(r.rstrip(os.sep) + os.sep)


# --- листы для проверки глазами ---

def _over(rgba, bg=(140, 140, 140)):
    a = rgba[..., 3:4] / 255.0
    return (rgba[..., :3] * a + np.array(bg) * (1 - a)).astype(np.uint8)


def _sheet_rows(args):
    name, picks, votes = args
    im = Image.open(os.path.join(SRC, name + '.webp'))
    shapes = shape_masks(name, im.n_frames, im.size)
    rows = []
    for i, why in picks:
        im.seek(i)
        rgba = np.asarray(im.convert('RGBA'))
        parts, cut = shapes[i]
        wh, we, lab, area, ring_keep, _ = frame_ring(rgba, cut)
        m, keep, by_shape, by_vote = frame_mask(wh, we, lab, area, ring_keep, parts, cut, votes)
        tiles = [_over(rgba)] + [_over(L.recolour(rgba, hair, 'violet', m)) for hair in ('gold', 'silver', 'black')]
        tiles.append(_over(L.recolour(rgba, 'red', 'green', m)))
        ov = _over(rgba)
        ov[:] = (ov.mean(-1, keepdims=True) * 0.6 + 40).astype(np.uint8)
        small = keep[lab] & (area[lab] < L.RING_BIG)
        ov[keep[lab] & ~small] = (60, 60, 220)
        ov[small] = (40, 230, 40)
        ov[m & (wh > 0.05)] = (255, 40, 40)
        ov[by_vote[lab]] = (255, 160, 0)
        ov[by_shape[lab]] = (255, 0, 255)
        if cut is not None:
            ov[cut & m & (wh > 0.05)] = (0, 220, 230)
        tiles.append(ov)
        rows.append((f'{name} f{i} {why}', tiles))
    return rows


def sheets(out_dir, stats, votes, flick, per_sheet=3, scale=0.75):
    os.makedirs(out_dir, exist_ok=True)
    jobs = []
    for name in sorted(stats):
        st = stats[name]
        a = max(range(len(st)), key=lambda i: (st[i]['suspect'], -i))
        b = max(range(len(st)), key=lambda i: (st[i]['dropped'] + st[i]['by_shape'], -i))
        picks = [(a, 'больше мелких кусков на светлом')] + ([(b, 'больше снято маской')] if b != a else [])
        if flick[name]:
            f = max(flick[name], key=lambda e: (e[3], -e[0]))
            picks += [(f[0], f'мигает: {f[2]} px своего цвета'), (f[1], f'мигает: из них {f[3]} px перекрашены')]
        jobs.append((name, picks, votes[name]))
    with Pool(min(12, os.cpu_count() or 1)) as pool:
        rows_by = pool.map(_sheet_rows, jobs)
    cols = ['исходник', 'золотистые', 'серебристые', 'чёрные', 'зелёные глаза', 'разметка']
    tw, th = int(400 * scale), int(427 * scale)
    try:
        font = ImageFont.truetype('arial.ttf', 13)  # у шрифта Pillow по умолчанию нет кириллицы
    except OSError:
        font = None
    written = []
    for s in range(0, len(rows_by), per_sheet):
        rows = [r for rr in rows_by[s:s + per_sheet] for r in rr]
        S = Image.new('RGB', (tw * len(cols), 18 + (th + 16) * len(rows)), (24, 24, 24))
        d = ImageDraw.Draw(S)
        for c, t in enumerate(cols):
            d.text((c * tw + 6, 2), t, fill=(255, 255, 0), font=font)
        for r, (label, tiles) in enumerate(rows):
            y = 18 + r * (th + 16)
            d.text((6, y + 1), label, fill=(255, 255, 0), font=font)
            for c, t in enumerate(tiles):
                S.paste(Image.fromarray(t).resize((tw, th), Image.LANCZOS), (c * tw, y + 16))
        p = os.path.join(out_dir, f'sheet_{s // per_sheet + 1:02d}.png')
        S.save(p)
        written.append(p)
    return written


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')
    all_names = sorted(f[:-5] for f in os.listdir(SRC) if f.endswith('.webp'))
    if argv[:1] == ['--check']:
        with Pool(min(12, os.cpu_count() or 1)) as pool:
            res = pool.map(check_files, argv[1:] or all_names)
        print(json.dumps({name: dict(flicker=fl, eye=eye) for name, fl, eye in res}, ensure_ascii=False))
        return
    sheet_dir = None
    if '--sheets' in argv:
        k = argv.index('--sheets')
        if k + 1 >= len(argv):
            sys.exit('--sheets: нужна папка для листов')
        sheet_dir = os.path.abspath(argv[k + 1])
        if not outside_repo(sheet_dir):
            sys.exit('--sheets: листы не кладутся в репозиторий, нужна папка снаружи')
        argv = argv[:k] + argv[k + 2:]
    names = argv or all_names
    unknown = [n for n in SHAPES if n not in names] if not argv else []
    if unknown:
        sys.exit(f'в SHAPES анимации, которых нет в {SRC}: {unknown}')
    version = look_version()
    old = read_manifest()
    os.makedirs(DST, exist_ok=True)
    with Pool(min(12, os.cpu_count() or 1)) as pool:
        res = pool.map(build, names)
    total = 0
    stats, votes, flick = {}, {}, {}
    files = dict(old['files']) if old and argv else {}
    changed, problems = [], []
    for name, n, size, st, vt, fl, src_sha, keep_sha in res:
        total += size
        stats[name] = st
        votes[name] = vt
        flick[name] = fl
        sh = sum(x['by_shape'] for x in st)
        bv = sum(x['by_vote'] for x in st)
        bc = sum(x['by_cut'] for x in st)
        print(f'{name:10s} кадров {n:3d}  {size / 1024:6.1f} КБ  маска в среднем {sum(x["keep"] for x in st) / n:5.0f} px'
              + (f'  голосование поменяло {bv} px' if bv else '')
              + (f'  снято фигурами {sh} px (кусок до {max(x["by_shape_max"] for x in st)})' if sh else '')
              + (f'  вырезано {bc} px' if bc else ''))
        if fl:
            worst = sorted(fl, key=lambda e: -e[3])[:5]
            problems.append(f'{name}: мигает {len(fl)} раз — (кадр, соседний, px своего цвета, из них перекрашено '
                            f'на соседнем, рамка x0 y0 x1 y1): {worst}; лечится фигурой C (вещь у волос) или H (волосы)')
        key = name + '.webp'
        if not old or old['files'].get(key, {}).get('keep') != keep_sha:
            changed.append(name)
        files[key] = dict(src=src_sha, keep=keep_sha)
    print(f'всего {len(res)} масок, {total / 1024 / 1024:.2f} МБ' + (f', поменялись: {", ".join(changed)}' if changed else ''))
    if old and version < old['version']:
        problems.append(f'LOOK_VERSION в look.js ({version}) меньше, чем у масок в sources.json ({old["version"]})')
    elif old and changed and version == old['version']:
        problems.append(f'маски поменялись, а LOOK_VERSION в desktop/renderer/look.js всё ещё {version}, как в sources.json: '
                        f'подними LOOK_VERSION (иначе виджет возьмёт старую перекраску из кэша) и запусти make_masks.py снова')
    if sheet_dir:
        for p in sheets(sheet_dir, stats, votes, flick):
            print('лист', p)
    if problems:
        print('sources.json НЕ обновлён:')
        for p in problems:
            print(' -', p)
        sys.exit(1)
    write_manifest(version, files)
    print(f'sources.json: {len(files)} масок для LOOK_VERSION {version}')


if __name__ == '__main__':
    main(sys.argv[1:])
