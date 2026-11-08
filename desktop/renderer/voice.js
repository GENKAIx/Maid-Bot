// Запись голоса с микрофона для /api/voice: Voice.start() → Voice.stop() даёт { audio (base64), mime } или null.
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
  let sampler = 0;
  const STEP = 70;

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
        while (levels.length < due) levels.push(lv);
        if (levels.length > 2000) levels.splice(0, levels.length - 2000);
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
    const blob = await finish();
    if (short || !blob.size) return null;
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
      const n = Math.floor(w / (bar + gap));
      // Последний столбик плавно «въезжает» справа между отсчётами.
      const shift = ((Date.now() - startedAt) % STEP) / STEP * (bar + gap);
      for (let i = 0; i <= n; i++) {
        const lv = levels[levels.length - 1 - i];
        const x = w - (i + 1) * (bar + gap) + gap - shift + (bar + gap);
        if (x < -bar) break;
        const bh = lv === undefined ? bar : Math.max(bar, lv * h * 0.9);
        g.globalAlpha = lv === undefined ? 0.35 : 1;
        g.fillRect(x, (h - bh) / 2, bar, bh);
      }
      g.globalAlpha = 1;
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  const clock = () => {
    const s = rec ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return { start, stop, cancel, wave, clock, get on() { return Boolean(rec); }, get seconds() { return rec ? Math.floor((Date.now() - startedAt) / 1000) : 0; } };
})();
