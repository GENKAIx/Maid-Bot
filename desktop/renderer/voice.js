// Запись голоса с микрофона для /api/voice: Voice.start() → Voice.stop() даёт { audio (base64), mime } или null.
const Voice = (() => {
  const MAX_MS = 120_000; // дольше — сама останавливается и отправляет
  const MIN_MS = 500; // короче — случайный щелчок, не отправляем
  let rec = null;
  let chunks = [];
  let startedAt = 0;
  let timer = 0;

  async function start(onLimit) {
    if (rec) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
    chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(250);
    startedAt = Date.now();
    timer = setTimeout(() => onLimit?.(), MAX_MS);
  }

  function finish() {
    const r = rec;
    rec = null;
    clearTimeout(timer);
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

  return { start, stop, cancel, get on() { return Boolean(rec); }, get seconds() { return rec ? Math.floor((Date.now() - startedAt) / 1000) : 0; } };
})();
