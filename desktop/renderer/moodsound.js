// Звуки эмоций горничной: у каждой реакции (react в widget.js) свой короткий звук — синтез WebAudio, без файлов,
// тихо и мягко, как у «стираю память» (zapTone). Основа (ждёт, думает, спит, нет связи) молчит; у «галочки», «серии» и
// «стираю память» свои звуки — тоже молчат. Звук-файл (play: ding, oops, hey) рядом важнее — тогда эмоция молчит.
const MOOD_SOUND_GAP = 1200; // не чаще раза в 1,2 с
let moodSoundAt = 0;
let fileSoundAt = 0; // когда играл звук-файл (widget.js, play)

// Звук появления облачка (настройка «popSound»): «пузырёк» — короткий тон снизу вверх, «колокольчик» — два чистых тона.
// Тот же синтез — в примере на странице «Виджет» (web/src/screens/Widget.tsx, popTone).
function popTone(ctx, dest, kind) {
  const t = ctx.currentTime + 0.005;
  const tone = (at, f0, f1, vol, len) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(f0, t + at);
    o.frequency.exponentialRampToValueAtTime(f1, t + at + Math.min(len, 0.09));
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(vol, t + at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + len);
    o.connect(g).connect(dest);
    o.start(t + at);
    o.stop(t + at + len + 0.05);
  };
  if (kind === "chime") {
    tone(0, 1318.5, 1318.5, 0.09, 0.55);
    tone(0.07, 1975.5, 1975.5, 0.07, 0.6);
  } else {
    tone(0, 380, 920, 0.22, 0.13);
    tone(0, 570, 1380, 0.06, 0.1);
  }
}
function bubbleSound() {
  if (cfg.mute || cfg.popSound === "off") return;
  try {
    actx ??= new AudioContext();
    popTone(actx, actx.destination, cfg.popSound);
  } catch {
    /* нет звука — не беда */
  }
}

function moodSound(n) {
  const make = MOOD_SOUNDS[n];
  if (!make || cfg.mute) return;
  const now = Date.now();
  if (now - moodSoundAt < MOOD_SOUND_GAP) return;
  moodSoundAt = now;
  // Чуть позже реакции: если облачко принесло свой звук-файл, он успеет сыграть, и эмоция промолчит.
  setTimeout(() => {
    if (cfg.mute || Date.now() - fileSoundAt < 500) return;
    try {
      actx ??= new AudioContext();
      const out = actx.createGain();
      out.gain.value = 1.2;
      const lp = actx.createBiquadFilter(); // мягче: без резких верхов
      lp.type = "lowpass";
      lp.frequency.value = 6500;
      out.connect(lp).connect(actx.destination);
      make(new MoodSynth(actx, out, actx.currentTime + 0.01));
    } catch {
      /* нет звука — не беда */
    }
  }, 90);
}

// Кирпичики: «голосок» — тон со скольжением и вибрато, шум через фильтр (дыхание, шорох, щелчок), колокольчик.
class MoodSynth {
  constructor(ctx, out, t) { this.ctx = ctx; this.out = out; this.t = t; }
  // Тон: от f0 к f1 за dur, с атакой и спадом; vib — вибрато в полутонах.
  voice(at, f0, f1, dur, vol, { type = "sine", vib = 0, rate = 7, attack = 0.015 } = {}) {
    const c = this.ctx, a = this.t + at, b = a + dur;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, a);
    o.frequency.exponentialRampToValueAtTime(f1, b);
    if (vib) {
      const l = c.createOscillator(), lg = c.createGain();
      l.frequency.value = rate;
      lg.gain.value = ((f0 + f1) / 2) * (Math.pow(2, vib / 12) - 1);
      l.connect(lg).connect(o.frequency);
      l.start(a);
      l.stop(b + 0.05);
    }
    g.gain.setValueAtTime(0.0001, a);
    g.gain.exponentialRampToValueAtTime(vol, a + attack);
    g.gain.setValueAtTime(vol, Math.max(a + attack, b - dur * 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, b);
    o.connect(g).connect(this.out);
    o.start(a);
    o.stop(b + 0.05);
  }
  // Шум через фильтр: f0 → f1 (частота фильтра), kind — lowpass / bandpass / highpass.
  noise(at, dur, vol, { kind = "bandpass", f0 = 2000, f1 = f0, q = 1, attack = 0.01 } = {}) {
    const c = this.ctx, a = this.t + at, b = a + dur;
    const n = c.createBufferSource();
    const buf = c.createBuffer(1, Math.max(1, Math.round(c.sampleRate * dur)), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    n.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = kind;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, a);
    f.frequency.exponentialRampToValueAtTime(f1, b);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, a);
    g.gain.exponentialRampToValueAtTime(vol, a + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, b);
    n.connect(f).connect(g).connect(this.out);
    n.start(a);
  }
  // Колокольчик: два синуса с нецелым обертоном, долгий спад.
  bell(at, f, vol, dur = 0.6) {
    this.voice(at, f, f, dur, vol, { attack: 0.004 });
    this.voice(at, f * 2.76, f * 2.76, dur * 0.5, vol * 0.35, { attack: 0.004 });
  }
}

const semi = (f, s) => f * Math.pow(2, s / 12);
const MOOD_SOUNDS = {
  // Радуется: два звонких «тю-лик» вверх.
  happy: (s) => { s.voice(0, 880, 1040, 0.09, 0.12); s.voice(0.1, 1100, 1320, 0.14, 0.12); },
  // Гордится: короткое «та-да» мажорным аккордом вверх.
  proud: (s) => { [0, 4, 7].forEach((k, i) => s.voice(i * 0.08, semi(660, k), semi(660, k), 0.12, 0.09, { type: "triangle" }));
    s.voice(0.26, semi(660, 12), semi(660, 12), 0.35, 0.1, { type: "triangle", vib: 0.2, rate: 6 }); },
  // В восторге: быстрое арпеджио вверх и россыпь колокольчиков.
  excited: (s) => { [0, 4, 7, 12, 16].forEach((k, i) => s.voice(i * 0.055, semi(740, k), semi(740, k + 1), 0.08, 0.09));
    [0, 3, 7].forEach((k, i) => s.bell(0.3 + i * 0.07, semi(2350, k), 0.03, 0.5)); },
  // Хихикает: «хи-хи-хи» — четыре прыгающих писка вниз с придыханием.
  giggle: (s) => { [0, -1, -3, -4].forEach((k, i) => { s.voice(i * 0.085, semi(1300, k + 2), semi(1300, k), 0.06, 0.08, { type: "triangle" });
    s.noise(i * 0.085, 0.05, 0.012, { f0: 3500, q: 2 }); }); },
  // Смущённо рада: мягкое «уи~» вверх с вибрато и тихий колокольчик.
  smitten: (s) => { s.voice(0, 620, 940, 0.42, 0.1, { vib: 0.35, rate: 9, attack: 0.05 }); s.bell(0.35, 1880, 0.025, 0.7); },
  // Грустит: «у-у» вниз с вибрато.
  sad: (s) => { s.voice(0, 520, 470, 0.25, 0.08, { vib: 0.3, rate: 5, attack: 0.04 });
    s.voice(0.27, 440, 330, 0.5, 0.08, { vib: 0.4, rate: 5, attack: 0.04 }); },
  // Тревожится: дрожащее «хм-м?» — два тона, второй выше.
  worried: (s) => { s.voice(0, 420, 400, 0.18, 0.07, { vib: 0.8, rate: 11 }); s.voice(0.2, 460, 560, 0.24, 0.07, { vib: 0.8, rate: 11 }); },
  // Удивлена: «уп!» — быстрый взлёт.
  surprised: (s) => { s.voice(0, 420, 1250, 0.16, 0.11, { attack: 0.008 }); s.noise(0, 0.05, 0.015, { f0: 1800, q: 1.5 }); },
  // «Ой!»: короткий вдох и писк вверх.
  gasp: (s) => { s.noise(0, 0.12, 0.05, { kind: "bandpass", f0: 1200, f1: 2600, q: 0.8, attack: 0.02 }); s.voice(0.06, 900, 1500, 0.1, 0.09); },
  // Недовольна: «хмпф» — два глухих выдоха с ворчанием.
  angry: (s) => { [0, 0.2].forEach((at) => { s.voice(at, 150, 120, 0.14, 0.09, { type: "sawtooth", vib: 1.2, rate: 30 });
    s.noise(at, 0.14, 0.035, { kind: "lowpass", f0: 900, f1: 400 }); }); },
  // Отказ: твёрдое «не-а» — два тона вниз.
  refuse: (s) => { s.voice(0, 560, 560, 0.11, 0.08, { type: "square", attack: 0.005 }); s.voice(0.15, 420, 400, 0.18, 0.08, { type: "square", attack: 0.005 }); },
  // Довольна собой: «хе-хе» и протяжное «м~» вверх.
  smug: (s) => { s.voice(0, 520, 480, 0.06, 0.08, { type: "triangle" }); s.voice(0.1, 520, 480, 0.06, 0.08, { type: "triangle" });
    s.voice(0.24, 440, 620, 0.32, 0.08, { vib: 0.25, rate: 6, attack: 0.04 }); },
  // Машет: «при-ве-ет» — вверх и вниз.
  hello: (s) => { s.voice(0, 700, 940, 0.1, 0.1); s.voice(0.12, 1050, 1050, 0.08, 0.1); s.voice(0.22, 1000, 820, 0.22, 0.1, { vib: 0.2 }); },
  // Кланяется: вежливый колокольчик вниз.
  bow: (s) => { s.bell(0, 1320, 0.05, 0.6); s.bell(0.18, 990, 0.045, 0.8); },
  // Слушает: «м?» — короткий вопрос вверх.
  listen: (s) => { s.voice(0, 500, 700, 0.15, 0.08, { attack: 0.03 }); },
  // Пишет: перо по бумаге — три шороха.
  write: (s) => { [0, 0.13, 0.3].forEach((at, i) => s.noise(at, 0.09 + i * 0.03, 0.15, { f0: 3800, f1: 5200, q: 3 })); },
  // Пьёт чай: «ах~» и звон чашки.
  tea: (s) => { s.noise(0, 0.4, 0.07, { kind: "bandpass", f0: 900, f1: 600, q: 0.7, attack: 0.08 }); s.bell(0.45, 2200, 0.035, 0.5); },
  // Метёт: два взмаха метлы.
  clean: (s) => { [0, 0.32].forEach((at) => s.noise(at, 0.24, 0.12, { kind: "bandpass", f0: 1500, f1: 4500, q: 0.9, attack: 0.06 })); },
};
