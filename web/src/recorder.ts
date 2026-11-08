// Запись голоса для /api/voice (как desktop/renderer/voice.js): start → stop даёт { audio (base64), mime } или null.
// Пока идёт запись, wave(canvas) рисует волну громкости — новые столбики справа.

const MAX_MS = 120_000;
const MIN_MS = 500;
const STEP = 70;

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private ctx: AudioContext | null = null;
  private sampler = 0;
  private limit = 0;
  private levels: number[] = [];

  get on() {
    return Boolean(this.rec);
  }

  clock() {
    const s = this.rec ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  async start(onLimit: () => void) {
    if (this.rec) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
    this.chunks = [];
    rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    rec.start(250);
    this.rec = rec;
    this.startedAt = Date.now();
    this.levels = [];
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      this.ctx = ctx;
      this.sampler = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const lv = Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.6);
        const due = Math.floor((Date.now() - this.startedAt) / STEP);
        while (this.levels.length < due) this.levels.push(lv);
      }, STEP);
    } catch {
      this.ctx = null;
    }
    this.limit = window.setTimeout(onLimit, MAX_MS);
  }

  private finish(): Promise<Blob> {
    const r = this.rec!;
    this.rec = null;
    clearTimeout(this.limit);
    clearInterval(this.sampler);
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    return new Promise((resolve) => {
      r.onstop = () => {
        r.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: r.mimeType || "audio/webm" }));
      };
      r.stop();
    });
  }

  async stop(): Promise<{ audio: string; mime: string } | null> {
    if (!this.rec) return null;
    const short = Date.now() - this.startedAt < MIN_MS;
    const blob = await this.finish();
    if (short || !blob.size) return null;
    const audio = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    return { audio, mime: blob.type };
  }

  async cancel() {
    if (this.rec) await this.finish();
  }

  wave(canvas: HTMLCanvasElement, color: string) {
    const g = canvas.getContext("2d");
    if (!g) return;
    const draw = () => {
      if (!this.rec || !canvas.isConnected) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
      g.clearRect(0, 0, w, h);
      g.fillStyle = color;
      const bar = 2 * dpr;
      const pitch = 4 * dpr;
      const shift = (((Date.now() - this.startedAt) % STEP) / STEP) * pitch;
      for (let i = 0; i * pitch < w + pitch; i++) {
        const lv = this.levels[this.levels.length - 1 - i];
        const x = w - i * pitch - shift;
        const bh = lv === undefined ? bar : Math.max(bar, lv * h * 0.9);
        g.globalAlpha = lv === undefined ? 0.35 : 1;
        g.fillRect(x, (h - bh) / 2, bar, bh);
      }
      g.globalAlpha = 1;
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }
}
