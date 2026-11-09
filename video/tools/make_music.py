# Музыка для ролика: лёгкая уютная мелодия (фа мажор, 104 уд/мин) — калимба, маримба, колокольчики, мягкий пэд,
# бас и тихие ударные. Синтез без сэмплов. python tools/make_music.py -> public/sfx/music.wav
import sys
import numpy as np
from scipy.signal import fftconvolve, butter, sosfilt
from scipy.io import wavfile

SR = 44100
BPM = 104
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(7)

INTRO, A1, B, A2, OUTRO = 4, 8, 8, 8, 4
BARS = INTRO + A1 + B + A2 + OUTRO
TAIL = 4.0
N = int((BARS * BAR + TAIL) * SR)
L = np.zeros(N)
R = np.zeros(N)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def put(sig, t, pan=0.0, gain=1.0):
    i = int(t * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    R[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))


def env(n, a, d):
    t = np.arange(n) / SR
    return np.minimum(1, t / a) * np.exp(-t / d)


def kalimba(m, dur=1.2):
    n = int(dur * SR); t = np.arange(n) / SR; f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t / 0.05) + 0.15 * np.sin(2 * np.pi * f * 2 * t)
    return s * env(n, 0.002, 0.35)


def marimba(m, dur=1.0):
    n = int(dur * SR); t = np.arange(n) / SR; f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 3.93 * t) * np.exp(-t / 0.04) + 0.1 * np.sin(2 * np.pi * f * 9.2 * t) * np.exp(-t / 0.015)
    return s * env(n, 0.003, 0.28 + 0.12 * (72 - min(m, 72)) / 12)


def bell(m, dur=2.0):
    n = int(dur * SR); t = np.arange(n) / SR; f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t / 0.3) + 0.2 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t / 0.12)
    return s * env(n, 0.001, 0.7)


def pad(ms, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    s = np.zeros(n)
    for m in ms:
        for det in (-0.07, 0.0, 0.07):
            f = hz(m + det)
            s += np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t) + 0.1 * np.sin(2 * np.pi * 3 * f * t)
    a = np.minimum(1, t / 0.6) * np.minimum(1, (dur - t) / 0.5).clip(0)
    return s * a / (3 * len(ms))


def bass(m, dur):
    n = int(dur * SR); t = np.arange(n) / SR; f = hz(m)
    s = np.tanh(1.6 * (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t)))
    return s * env(n, 0.005, 0.45) * np.minimum(1, (dur - t) / 0.03).clip(0)


def kick():
    n = int(0.35 * SR); t = np.arange(n) / SR
    f = 50 + 90 * np.exp(-t / 0.03)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.12)


def band(x, lo, hi):
    return sosfilt(butter(2, [lo, hi], btype="band", fs=SR, output="sos"), x)


def clap():
    n = int(0.25 * SR); t = np.arange(n) / SR
    e = np.exp(-t / 0.06) * (1 + 0.6 * np.exp(-((t - 0.012) ** 2) / 1e-5) + 0.4 * np.exp(-((t - 0.024) ** 2) / 1e-5))
    return band(rng.standard_normal(n), 900, 4000) * e


def shaker():
    n = int(0.09 * SR); t = np.arange(n) / SR
    return band(rng.standard_normal(n), 5000, 12000) * np.minimum(1, t / 0.01) * np.exp(-t / 0.025)


CH = {"F": [53, 57, 60], "Dm": [50, 53, 57], "Bb": [46, 50, 53], "C": [48, 52, 55], "Am": [45, 48, 52]}
ROOT = {"F": 41, "Dm": 38, "Bb": 34, "C": 36, "Am": 33}
PROG_A = ["F", "Dm", "Bb", "C", "F", "Dm", "Bb", "C"]
PROG_B = ["Bb", "C", "Am", "Dm", "Bb", "C", "F", "F"]

MEL_A = [
    [(0, .5, 72), (.5, .5, 77), (1, .5, 76), (1.5, .5, 72), (2, 1, 74), (3, 1, 72)],
    [(0, .5, 69), (.5, .5, 72), (1, 1, 74), (2, .5, 77), (2.5, .5, 76), (3, 1, 74)],
    [(0, 1, 74), (1, .5, 72), (1.5, .5, 70), (2, 1.5, 69), (3.5, .5, 70)],
    [(0, .5, 72), (.5, .5, 74), (1, .5, 76), (1.5, .5, 79), (2, 2, 76)],
    [(0, .5, 72), (.5, .5, 77), (1, .5, 76), (1.5, .5, 72), (2, 1, 74), (3, 1, 72)],
    [(0, .5, 81), (.5, .5, 79), (1, .5, 77), (1.5, .5, 76), (2, 1, 74), (3, 1, 77)],
    [(0, .5, 74), (.5, .5, 77), (1, 1, 81), (2, .5, 79), (2.5, .5, 77), (3, 1, 76)],
    [(0, .5, 79), (.5, .5, 77), (1, 1, 76), (2, 2, 72)],
]
MEL_B = [
    [(0, .75, 77), (.75, .75, 74), (1.5, .5, 77), (2, 1, 82), (3, 1, 81)],
    [(0, .75, 79), (.75, .75, 76), (1.5, .5, 79), (2, 2, 84)],
    [(0, .5, 81), (.5, .5, 84), (1, 1, 81), (2, .5, 79), (2.5, .5, 77), (3, 1, 76)],
    [(0, 1.5, 77), (1.5, .5, 74), (2, 2, 81)],
    [(0, .5, 82), (.5, .5, 81), (1, .5, 79), (1.5, .5, 77), (2, 1, 79), (3, 1, 77)],
    [(0, .5, 76), (.5, .5, 77), (1, .5, 79), (1.5, .5, 81), (2, 2, 84)],
    [(0, 1, 81), (1, 1, 77), (2, 1, 72), (3, 1, 77)],
    [(0, 3, 77)],
]


def bar_chords():
    out = PROG_A[:4]
    out += PROG_A + PROG_B + PROG_A
    out += ["F", "Bb", "C", "F"]
    return out


chords = bar_chords()
for b, c in enumerate(chords):
    t0 = b * BAR
    tones = CH[c]
    sec = "intro" if b < INTRO else "A" if b < INTRO + A1 else "B" if b < INTRO + A1 + B else "A2" if b < INTRO + A1 + B + A2 else "out"
    # Пэд
    put(pad([m + 12 for m in tones], BAR + 0.4), t0, 0.0, 0.10 if sec != "intro" else 0.07)
    # Калимба: арпеджио восьмыми
    arp = [tones[0] + 12, tones[1] + 12, tones[2] + 12, tones[0] + 24, tones[2] + 12, tones[1] + 12, tones[2] + 12, tones[0] + 24]
    for k, m in enumerate(arp):
        if sec == "out" and b == len(chords) - 1 and k > 0:
            break
        swing = 0.03 * BEAT if k % 2 else 0
        put(kalimba(m), t0 + k * BEAT / 2 + swing, -0.45 if k % 2 else -0.2, 0.17 * (1.1 if k % 4 == 0 else 0.85))
    if sec == "intro" or sec == "out":
        if sec == "out":
            put(bass(ROOT[c], BAR * 0.9), t0, 0, 0.22)
        continue
    # Бас: подпрыгивающий
    r = ROOT[c]
    for at, d, m in [(0, 1.2, r), (1.5, .45, r), (2, .9, r + 12 if sec == "B" else r), (3, .45, r + 7), (3.5, .45, r + 12)]:
        put(bass(m, d * BEAT), t0 + at * BEAT, 0, 0.26)
    # Ударные
    for q in range(4):
        if q in (0, 2):
            put(kick(), t0 + q * BEAT, 0, 0.55)
        if q in (1, 3):
            put(clap(), t0 + q * BEAT, 0.1, 0.20)
    for k in range(8):
        put(shaker(), t0 + k * BEAT / 2 + (0.03 * BEAT if k % 2 else 0), 0.5, 0.10 if k % 2 else 0.06)
    # Мелодия
    i = b - INTRO
    mel = MEL_A[i % 8] if sec in ("A", "A2") else MEL_B[i % 8]
    for at, d, m in mel:
        put(marimba(m, max(0.6, d * BEAT + 0.4)), t0 + at * BEAT, 0.25, 0.30)
        if sec == "B" or (sec == "A2" and i % 8 >= 4):
            put(bell(m + 12), t0 + at * BEAT, 0.5, 0.07)
    if sec == "A2" and (i % 8) in (3, 7):
        for k, m in enumerate([84, 88, 91, 96]):
            put(bell(m), t0 + 3 * BEAT + k * BEAT / 4, 0.6, 0.06)

# Финальный аккорд
t_end = BARS * BAR
for m in [65, 69, 72, 77, 81]:
    put(bell(m + 12, 3.5), t_end - BAR + 0.02 * (m - 65), 0.3, 0.07)

# Реверб
ir_n = int(1.8 * SR)
ir = rng.standard_normal(ir_n) * np.exp(-np.arange(ir_n) / SR / 0.45)
ir = sosfilt(butter(2, 5000, fs=SR, output="sos"), ir)
ir /= np.sqrt((ir ** 2).sum())
wl = fftconvolve(L, ir)[:N]
wr = fftconvolve(R, np.roll(ir, 400))[:N]
L2 = L + 0.22 * wl
R2 = R + 0.22 * wr
mix = np.stack([L2, R2], 1)
mix /= np.abs(mix).max() / 0.89
fade = int(1.5 * SR)
mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
out = sys.argv[1] if len(sys.argv) > 1 else "public/sfx/music.wav"
wavfile.write(out, SR, (mix * 32767).astype(np.int16))
print(out, round(N / SR, 1), "s")
