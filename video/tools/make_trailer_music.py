# -*- coding: utf-8 -*-
"""Музыка трейлера «Твоя горничная»: 120 уд/мин (такт = 2 с = 60 кадров), 46 тактов, синтез на numpy.
Разделы совпадают с монтажом (src/Trailer.tsx): вступление 0–4, грув 4–18, лёгкая часть (полная версия) 18–23,
грув 23–41, такт тишины-подъёма перед вспышкой 41–42, удар и финал 42–46.
python tools/make_trailer_music.py  →  public/sfx/trailer.mp3, whoosh.wav, zap.wav, hit.wav
"""
import os, subprocess, wave
import numpy as np

SR = 44100
BPM = 120
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 46
N = int(BARS * BAR * SR)
rng = np.random.RandomState(7)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'sfx')


def hz(m):
    return 440 * 2 ** ((m - 69) / 12)


def env(n, a, d, s=0.0, curve=4.0):
    t = np.arange(n) / SR
    e = np.exp(-t * curve / max(d, 1e-3)) * (1 - s) + s
    k = max(1, int(a * SR))
    e[:k] *= np.linspace(0, 1, k)
    return e


def add(buf, at, sig, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[:N - i]
    buf[i:i + len(sig), 0] += sig * gain * (1 - max(0, pan))
    buf[i:i + len(sig), 1] += sig * gain * (1 + min(0, pan))


def osc(f, n, kind='saw', det=0.0):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for d in ((0,) if not det else (-det, 0, det)):
        ph = (f * (1 + d) * t) % 1
        out += {'saw': 2 * ph - 1, 'sq': np.where(ph < 0.5, 1.0, -1.0), 'tri': 2 * np.abs(2 * ph - 1) - 1, 'sin': np.sin(2 * np.pi * ph)}[kind]
    return out / (3 if det else 1)


def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def lp_fast(x, cutoff, passes=2):
    k = max(1, int(SR / (2 * np.pi * cutoff)))
    ker = np.ones(k) / k
    for _ in range(passes):
        x = np.convolve(x, ker, mode='same')
    return x


def kick():
    n = int(0.32 * SR)
    t = np.arange(n) / SR
    f = 46 + 110 * np.exp(-t * 34)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.001, 0.26, curve=5) + 0.25 * lp_fast(rng.randn(n), 5000) * env(n, 0.0005, 0.012)


def clap():
    n = int(0.22 * SR)
    x = rng.randn(n)
    x = x - lp_fast(x, 900)
    e = sum(np.concatenate([np.zeros(int(d * SR)), env(n - int(d * SR), 0.001, 0.09)]) for d in (0, 0.011, 0.023)) / 2.2
    return x * e


def hat(open_=False):
    n = int((0.16 if open_ else 0.045) * SR)
    x = rng.randn(n)
    x = x - lp_fast(x, 6000)
    return x * env(n, 0.0005, 0.12 if open_ else 0.03)


def pluck(m, dur=0.22, bright=1.0):
    n = int(dur * SR)
    x = osc(hz(m), n, 'saw', 0.004) * 0.6 + osc(hz(m + 12), n, 'sq') * 0.2 * bright
    return lp_fast(x, 1800 + 2600 * bright, 1) * env(n, 0.002, dur * 0.7)


def bass(m, dur):
    n = int(dur * SR)
    x = osc(hz(m), n, 'saw') * 0.5 + osc(hz(m), n, 'sin') * 0.8
    return lp_fast(x, 520, 2) * env(n, 0.004, dur, s=0.25, curve=3)


def pad(notes, dur, cutoff=1400):
    n = int(dur * SR)
    x = sum(osc(hz(m), n, 'saw', 0.006) for m in notes) / len(notes)
    e = np.ones(n)
    k = int(0.25 * SR)
    e[:k] = np.linspace(0, 1, k)
    e[-k:] = np.linspace(1, 0, k)
    return lp_fast(x, cutoff, 2) * e


def riser(dur):
    n = int(dur * SR)
    t = np.linspace(0, 1, n)
    x = rng.randn(n)
    x = x - lp_fast(x, 1200)
    tone = np.sin(2 * np.pi * np.cumsum(300 + 2400 * t ** 2) / SR) * 0.25
    return (x * 0.5 + tone) * t ** 2


def hit():
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    sub = np.sin(2 * np.pi * np.cumsum(38 + 90 * np.exp(-t * 9)) / SR) * env(n, 0.001, 1.4, curve=3)
    crash = rng.randn(n)
    crash = (crash - lp_fast(crash, 2500)) * env(n, 0.001, 1.6, curve=3) * 0.5
    return sub * 1.2 + crash


# Аккорды: Am F C G — по такту, ноты MIDI.
CH = [(57, [69, 72, 76]), (53, [69, 72, 77]), (48, [67, 72, 76]), (55, [67, 71, 74])]
PENTA = [69, 72, 74, 76, 79, 81, 84]
LEAD = [  # мелодия на 4 такта: (доля, нота, длина в долях)
    (0, 76, 1), (1, 79, 0.5), (1.5, 81, 1), (3, 79, 1),
    (4, 77, 1), (5, 76, 0.5), (5.5, 72, 1), (7, 74, 1),
    (8, 76, 1), (9, 79, 0.5), (9.5, 84, 1.5), (11.5, 83, 0.5),
    (12, 79, 1), (13, 74, 0.5), (13.5, 76, 1), (15, 74, 1),
]

drums = np.zeros((N, 2))
music = np.zeros((N, 2))
K, C, H, HO = kick(), clap(), hat(), hat(True)
duck = np.ones(N)


def section(bar):
    if bar < 2: return 'intro'
    if bar < 4: return 'build'
    if bar < 18: return 'groove'
    if bar < 23: return 'light'
    if bar < 30: return 'groove'
    if bar < 31.5: return 'sleep'
    if bar < 41: return 'groove'
    if bar < 42: return 'gap'
    return 'final'


for bar in range(BARS):
    sec = section(bar)
    t0 = bar * BAR
    root, tri = CH[bar % 4]
    peak = sec == 'final' or (sec == 'groove' and (7 <= bar < 15 or 33 <= bar < 41))
    for b in range(4):
        tb = t0 + b * BEAT
        s2 = section(bar + b / 4)
        if s2 in ('groove', 'final') or (s2 == 'build' and bar >= 3) or (s2 == 'light' and b in (0, 2)):
            add(drums, tb, K, 0.95 if s2 != 'light' else 0.6)
            i = int(tb * SR)
            k = int(0.2 * SR)
            if i + k < N:
                duck[i:i + k] = np.minimum(duck[i:i + k], 0.35 + 0.65 * np.linspace(0, 1, k) ** 0.6)
        if s2 in ('groove', 'final') and b in (1, 3):
            add(drums, tb, C, 0.55)
        if s2 == 'light' and b == 2:
            add(drums, tb, C, 0.25)
        if s2 in ('groove', 'final', 'build'):
            add(drums, tb + BEAT / 2, HO if b == 3 and bar % 2 else H, 0.3, pan=0.25)
            if s2 != 'build':
                for q in (0.25, 0.75):
                    add(drums, tb + BEAT * q, H, 0.13, pan=-0.3)
        if s2 in ('light', 'sleep', 'intro'):
            add(drums, tb + BEAT / 2, H, 0.1, pan=0.3)
    if sec == 'gap':
        add(music, t0, riser(BAR - BEAT * 0.75), 0.5)
        add(drums, t0, K, 0.9)
        add(drums, t0 + BEAT, C, 0.5)
        continue
    # бас: «скачущий» восьмыми
    if sec in ('groove', 'final', 'build'):
        for e8 in range(8):
            if e8 in (0, 3, 4, 6, 7) or (peak and e8 == 2):
                add(music, t0 + e8 * BEAT / 2, bass(root - 12 + (12 if e8 in (3, 7) else 0), BEAT * 0.45), 0.5)
    elif sec in ('light', 'sleep'):
        add(music, t0, bass(root - 12, BAR * 0.9), 0.32)
    # арпеджио шестнадцатыми
    arp = tri + [tri[0] + 12]
    for s16 in range(16):
        on = sec in ('groove', 'final') or (sec in ('intro', 'build', 'light') and s16 % 2 == 0) or (sec == 'sleep' and s16 % 4 == 0)
        if on:
            m = arp[(s16 * 3) % 4] + (12 if (s16 // 4) % 2 and sec != 'sleep' else 0)
            add(music, t0 + s16 * BEAT / 4, pluck(m, 0.2, 1.0 if peak else 0.55), 0.2 if sec in ('groove', 'final') else 0.16, pan=0.35 * (1 if s16 % 2 else -1))
    # аккорды: стабы на слабые доли в груве, пэд в лёгкой части
    if sec in ('groove', 'final'):
        for b in (0.5, 1.5, 2.5, 3.25):
            n = int(0.14 * SR)
            st = sum(osc(hz(m), n, 'saw', 0.005) for m in tri) / 3
            add(music, t0 + b * BEAT, lp_fast(st, 3200, 1) * env(n, 0.002, 0.11), 0.26)
    if sec in ('light', 'sleep', 'intro', 'build', 'final'):
        add(music, t0, pad([m - 12 for m in tri] + [tri[1]], BAR, 1100 if sec != 'final' else 2400), 0.22 if sec != 'final' else 0.3)
    # мелодия
    if peak or sec == 'light':
        base = (bar % 4) * 4
        for at, m, ln in LEAD:
            if base <= at < base + 4:
                n = int(ln * BEAT * SR * 0.95)
                x = (osc(hz(m), n, 'tri') * 0.7 + osc(hz(m), n, 'sq', 0.003) * 0.25) * env(n, 0.008, ln * BEAT, s=0.3, curve=2.5)
                vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * np.arange(n) / SR)
                add(music, t0 + (at - base) * BEAT, lp_fast(x * vib, 3600, 1), 0.3 if sec != 'light' else 0.2, pan=-0.1)
    # сбивка перед новым разделом
    if section(bar + 1) != sec and sec in ('build', 'groove', 'light', 'sleep') and section(bar + 1) != 'gap':
        add(music, t0 + BAR - 2 * BEAT, riser(2 * BEAT), 0.3)
        for i, d in enumerate((2.5, 3, 3.25, 3.5, 3.75)):
            add(drums, t0 + d * BEAT, C, 0.25 + 0.07 * i)

add(drums, 42 * BAR, hit(), 0.9)
add(drums, 4 * BAR, hit(), 0.45)
add(drums, 23 * BAR, hit(), 0.4)
mix = drums + music * duck[:, None]
# эхо на музыку: восьмая с точкой
d = int(0.75 * BEAT * SR)
echo = np.zeros_like(music)
echo[d:] = music[:-d] * 0.22
echo[2 * d:] += music[:-2 * d] * 0.1
mix += echo[:, ::-1] * duck[:, None]
t = np.arange(N) / SR
fade = np.clip((BARS * BAR - t) / 3.0, 0, 1) * np.clip(t / 0.05, 0, 1)
mix *= fade[:, None]
mix = np.tanh(mix * 1.15) / np.tanh(1.15)
mix /= np.abs(mix).max() / 0.95


def save(name, x):
    x = np.clip(x, -1, 1)
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    with wave.open(os.path.join(OUT, name), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())


save('trailer.wav', mix)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', os.path.join(OUT, 'trailer.wav'), '-b:a', '192k', os.path.join(OUT, 'trailer.mp3')], check=True)
os.remove(os.path.join(OUT, 'trailer.wav'))

# звуки монтажа
n = int(0.42 * SR)
tt = np.linspace(0, 1, n)
wh = rng.randn(n)
wh = lp_fast(wh - lp_fast(wh, 500), 500 + 5000 * 0.5, 1) * np.sin(np.pi * tt) ** 2
save('whoosh.wav', wh / np.abs(wh).max() * 0.6)
n = int(1.3 * SR)
tt = np.arange(n) / SR
click = int(0.7 * SR)
whine = np.sin(2 * np.pi * np.cumsum(np.interp(tt, [0, 0.7], [1500, 3400])) / SR) * np.interp(tt, [0, 0.68, 0.7, 0.72], [0.02, 0.3, 0.3, 0]) * (tt < 0.72)
pew = np.zeros(n)
m = n - click
tp = np.arange(m) / SR
pew[click:] = (2 * np.abs(2 * ((np.cumsum(3200 * np.exp(-tp * 5.5) + 400) / SR) % 1) - 1) - 1) * np.exp(-tp * 7) * 0.6 + np.sin(2 * np.pi * np.cumsum(150 * np.exp(-tp * 4) + 45) / SR) * np.exp(-tp * 5) * 0.9
save('zap.wav', np.clip(whine + pew, -1, 1) * 0.8)
h = hit()
save('hit.wav', h / np.abs(h).max() * 0.8)
print('готово:', BARS * BAR, 'с')
