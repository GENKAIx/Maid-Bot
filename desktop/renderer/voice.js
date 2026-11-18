// Запись голоса с микрофона для /api/voice: Voice.start() → Voice.stop() даёт { audio (base64), mime }, { silent: true }
// (вся запись — тишина, микрофон выключен) или null.
const Voice = (() => {
  const MAX_MS = 120_000; // дольше — сама останавливается и отправляет
  const MIN_MS = 500; // короче — случайный щелчок, не отправляем
  let rec = null;
  let chunks = [];
  let startedAt = 0;
  let timer = 0;
  let ctx = null; // AudioContext для уровня громкости
  let analyser = null;
  let levels = []; // громкость 0..1, один столбик в STEP мс — для рисования волны
  let first = 0; // сколько старых замеров выброшено с начала (levels[0] — замер номер first)
  let sampler = 0;
  const STEP = 70;
  // Тишина — все замеры ниже QUIET: выключенный микрофон даёт ноль или почти ноль (~0,05), тихая комната — 0,15–0,3,
  // речь — 0,4 и выше. Судить — не меньше чем по HUSH_MIN замерам (~1,4 с); замеров нет (громкость не меряется) — не судить.
  const QUIET = 0.12;
  const HUSH_MIN = 20;
  const isHush = (lv) => lv.length >= HUSH_MIN && lv.every((v) => v < QUIET);

  async function start(onLimit) {
    if (rec) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
    chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(250);
    startedAt = Date.now();
    levels = [];
    first = 0;
    try {
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      sampler = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        // Речь у микрофона даёт RMS ~0,02–0,2; корень растягивает тихое, чтобы волна была видна.
        const lv = Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.6);
        // Таймер может приходить реже (окно в фоне) — столбиков столько, сколько прошло шагов, чтобы волна шла со временем.
        const due = Math.floor((Date.now() - startedAt) / STEP);
        while (first + levels.length < due) levels.push(lv);
        if (levels.length > 2000) first += levels.splice(0, levels.length - 2000).length;
      }, STEP);
    } catch {
      analyser = null;
    }
    timer = setTimeout(() => onLimit?.(), MAX_MS);
  }

  function finish() {
    const r = rec;
    rec = null;
    clearTimeout(timer);
    clearInterval(sampler);
    ctx?.close().catch(() => {});
    ctx = analyser = null;
    return new Promise((resolve) => {
      r.onstop = () => {
        r.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: r.mimeType || "audio/webm" }));
      };
      r.stop();
    });
  }

  async function stop() {
    if (!rec) return null;
    const short = Date.now() - startedAt < MIN_MS;
    const silent = isHush(levels);
    const blob = await finish();
    if (short || !blob.size) return null;
    if (silent) return { silent: true }; // вся запись — тишина: на сервер не отправлять
    const audio = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    return { audio, mime: blob.type };
  }

  async function cancel() {
    if (rec) await finish();
  }

  /** Где рисовать столбики волны: место каждого — по его времени (замер k — момент (k+1)·STEP), он въезжает из-за правого
   *  края и плавно уходит влево. Раньше место считалось по счёту от правого края, а сдвиг — по часам: таймер замеров
   *  опаздывает на миллисекунды, и в эти кадры вся волна прыгала на шаг вправо и обратно («глитч», 19.11.2026). */
  function waveBars(lv, from, elapsed, w, pitch, gap) {
    const out = [];
    for (let i = lv.length - 1; i >= 0; i--) {
      const x = w + gap - (elapsed - (from + i + 1) * STEP) / STEP * pitch;
      out.push({ x, lv: lv[i] });
      if (x < -pitch) break;
    }
    return out;
  }

  /** Рисует волну записи в canvas, пока идёт запись: столбики громкости, новые справа, старые уходят влево. */
  function wave(canvas, color = "#fff") {
    const g = canvas.getContext("2d");
    const draw = () => {
      if (!rec) return g.clearRect(0, 0, canvas.width, canvas.height);
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
      g.clearRect(0, 0, w, h);
      g.fillStyle = color;
      const bar = 2 * dpr;
      const gap = 2 * dpr;
      const pitch = bar + gap;
      const bars = waveBars(levels, first, Date.now() - startedAt, w, pitch, gap);
      for (const b of bars) g.fillRect(b.x, (h - Math.max(bar, b.lv * h * 0.9)) / 2, bar, Math.max(bar, b.lv * h * 0.9));
      // Левее первого замера (запись только началась) — бледные точки-заглушки тем же шагом.
      g.globalAlpha = 0.35;
      for (let x = (bars.at(-1)?.x ?? w + gap) - pitch; x >= -bar; x -= pitch) g.fillRect(x, (h - bar) / 2, bar, bar);
      g.globalAlpha = 1;
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  const clock = () => {
    const s = rec ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return { start, stop, cancel, wave, clock, isHush, waveBars, STEP, get hushed() { return isHush(levels); }, get on() { return Boolean(rec); }, get seconds() { return rec ? Math.floor((Date.now() - startedAt) / 1000) : 0; } };
})();
