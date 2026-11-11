// Трейлер «Твоя горничная» для страницы в Steam: настоящий виджет (развёрнутый и свёрнутый) и полная версия,
// записанные кадр за кадром (tools/trailer-record.mjs → public/rec/t_*). Монтаж по тактам: 120 уд/мин, такт = 60 кадров.
// Музыка — tools/make_trailer_music.py (разделы совпадают со сценами ниже).
import React from "react";
import { AbsoluteFill, AnimatedImage, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { loadFont as loadUnbounded } from "@remotion/google-fonts/Unbounded";
import { loadFont as loadManrope } from "@remotion/google-fonts/Manrope";
import SOUND_LOG from "./trailer-sounds.json";

const { fontFamily: HEAD } = loadUnbounded("normal", { weights: ["800"], subsets: ["cyrillic", "latin"] });
const { fontFamily: BODY } = loadManrope("normal", { weights: ["500", "700"], subsets: ["cyrillic", "latin"] });

const C = { ink: "#fff6ec", soft: "rgba(255,246,236,.74)", violet: "#b79cff", green: "#4fd09a", orange: "#ffb36b", pink: "#ff8a9a", blue: "#7cc4ff", yellow: "#ffe27a" };
const BAR = 60, BEAT = 15;
const RW = 930, RH = 1140; // кадр записи виджета (страница 620×760 ×1,5)

// Длина записей (кадры).
const LEN: Record<string, number> = { hello_open: 135, hello_fold: 135, poke: 228, write_open: 300, write_fold: 240, cancel: 315, clash: 240, remind_open: 135, remind_fold: 135,
  angry: 135, clean: 135, done: 270, sleep: 240, thanks: 195, games: 135, girl: 465, forget_fold: 210, full_diary: 225, full_stats: 240 };
// Родные звуки приложения: что и на каком кадре записи сыграл сам виджет (tools/trailer-record.mjs).
// Файл — из desktop/assets/sounds (громкость как в приложении), синтез WebAudio — отрендерен в public/sfx/app.
type Snd = { frame: number; file?: string; vol?: number; synth?: string };
const SOUNDS = SOUND_LOG as Record<string, Snd[]>;
const sndSrc = (s: Snd) => staticFile(s.file ? `sfx/${s.file}` : `sfx/app/${s.synth}.wav`);
const sndVol = (s: Snd) => (s.file ? (s.vol ?? 0.45) * 2 : 1); // всё ×2 к громкости приложения (синтез — уже в wav)
// Один звук, повторённый в двух виджетах дуэта на одном кадре, звучит один раз.
const AppSounds: React.FC<{ rec: string; from?: number; speed?: number; skip?: (s: Snd) => boolean }> = ({ rec, from = 0, speed = 1, skip }) => (
  <>
    {(SOUNDS[rec] ?? []).filter((s) => s.frame >= from && s.frame < LEN[rec] && !skip?.(s)).map((s, i) => (
      <Sequence key={i} from={Math.round((s.frame - from) / speed)} layout="none"><Audio src={sndSrc(s)} volume={sndVol(s)} /></Sequence>
    ))}
  </>
);
const GIRL_FLASH = 363; // кадр записи, где щёлкает прибор

const beatPulse = (f: number) => Math.exp(-((f % BEAT) / BEAT) * 3.2);

// --- фон: рабочий стол, пульсирует в долю ---
const Desktop: React.FC = () => {
  const f = useCurrentFrame();
  const p = beatPulse(f);
  const hue = interpolate(f, [0, 2730], [0, 50]);
  const blobs = [
    { x: 380, y: 260, r: 540, c: "rgba(183,156,255,.40)" },
    { x: 1540, y: 200, r: 480, c: "rgba(124,196,255,.24)" },
    { x: 940, y: 1000, r: 660, c: "rgba(255,138,154,.22)" },
  ];
  return (
    <AbsoluteFill style={{ background: "linear-gradient(160deg,#241a3d 0%,#2c2552 45%,#1b2340 100%)", overflow: "hidden", filter: `hue-rotate(${hue}deg)` }}>
      {blobs.map((b, i) => {
        const r = b.r * (1 + 0.05 * p);
        return <div key={i} style={{ position: "absolute", left: b.x - r + Math.sin(f * 0.02 + i * 2) * 90, top: b.y - r + Math.cos(f * 0.017 + i) * 60,
          width: r * 2, height: r * 2, borderRadius: "50%", background: `radial-gradient(circle, ${b.c}, transparent 65%)` }} />;
      })}
      <AbsoluteFill style={{ opacity: 0.07, backgroundImage: "radial-gradient(rgba(255,255,255,.9) 1px, transparent 1.4px)", backgroundSize: "26px 26px",
        backgroundPosition: `${-f * 0.4}px ${-f * 0.25}px` }} />
    </AbsoluteFill>
  );
};

// --- записанный виджет ---
const Widget: React.FC<{ name: string; x: number; y: number; scale: number; speed?: number; from?: number; delay?: number; label?: string; labelAt?: "top" | "mid"; color?: string; fx?: "up" | "left" | "right" | "pop"; skip?: (s: Snd) => boolean }> =
  ({ name, x, y, scale, speed = 1, from = 0, delay = 0, label, labelAt = "top", color = C.violet, fx = "up", skip }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = Math.min(LEN[name] - 1, Math.max(0, Math.round(from + f * speed)));
  const s = spring({ frame: f - delay, fps, config: { damping: 15, stiffness: 150 } });
  const move = fx === "left" ? `translateX(${(1 - s) * -260}px)` : fx === "right" ? `translateX(${(1 - s) * 260}px)` : fx === "pop" ? `scale(${0.8 + 0.2 * s})` : `translateY(${(1 - s) * 220}px)`;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: RW * scale, height: RH * scale, opacity: Math.min(1, s * 1.6), transform: move, transformOrigin: "70% 100%" }}>
      <Img src={staticFile(`rec/t_${name}/${String(n).padStart(4, "0")}.png`)} style={{ width: "100%", height: "100%", filter: "drop-shadow(0 30px 50px rgba(0,0,0,.4))" }} />
      {label ? <div style={{ position: "absolute", right: 30 * scale, top: labelAt === "top" ? 20 : RH * scale * 0.5, fontFamily: BODY, fontWeight: 700, fontSize: 28, color: "#241a3d", background: color,
        borderRadius: 30, padding: "8px 24px", whiteSpace: "nowrap" }}>{label}</div> : null}
      <AppSounds rec={name} from={from} speed={speed} skip={skip} />
    </div>
  );
};

// --- подписи: слова выскакивают по одному ---
const Caption: React.FC<{ title: string; sub?: string; color: string; x: number; y: number; w: number; size?: number; align?: "left" | "center"; tag?: string; delay?: number }> =
  ({ title, sub, color, x, y, w, size = 76, align = "left", tag, delay = 0 }) => {
  const f = useCurrentFrame() - delay;
  const { fps } = useVideoConfig();
  const words = title.split(" ");
  const subIn = spring({ frame: f - 8 - words.length * 2, fps, config: { damping: 18 } });
  const bar = spring({ frame: f - 2, fps, config: { damping: 20 } });
  if (f < 0) return null;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, textAlign: align }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, justifyContent: align === "center" ? "center" : "flex-start", marginBottom: 26 }}>
        <div style={{ width: 96 * bar, height: 10, borderRadius: 5, background: color }} />
        {tag ? <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: 24, color, letterSpacing: 1, opacity: bar }}>{tag}</div> : null}
      </div>
      <div style={{ fontFamily: HEAD, fontWeight: 800, fontSize: size, lineHeight: 1.1, color: C.ink, letterSpacing: -1 }}>
        {words.map((wd, i) => {
          const s = spring({ frame: f - 3 - i * 2, fps, config: { damping: 12, stiffness: 190 } });
          return <span key={i} style={{ display: "inline-block", marginRight: align === "left" ? size * 0.3 : size * 0.15, marginLeft: align === "left" ? 0 : size * 0.15,
            transform: `translateY(${(1 - s) * 60}px) rotate(${(1 - s) * -8}deg) scale(${0.7 + 0.3 * s})`, opacity: s }}>{wd}</span>;
        })}
      </div>
      {sub ? <div style={{ fontFamily: BODY, fontWeight: 500, fontSize: size * 0.46, lineHeight: 1.35, color: C.soft, marginTop: 24, opacity: subIn, transform: `translateY(${(1 - subIn) * 20}px)` }}>{sub}</div> : null}
    </div>
  );
};

// --- раскладки ---
type Solo = { rec: string; speed?: number; from?: number; zoom?: number; side: "left" | "right"; title: string; sub?: string; color: string; tag?: string };
const SoloScene: React.FC<Solo> = ({ rec, speed, from, zoom = 0.9, side, title, sub, color, tag }) => (
  <AbsoluteFill>
    <Widget name={rec} speed={speed} from={from} x={side === "right" ? 1880 - RW * zoom : 620 - RW * zoom * 0.72} y={1050 - RH * zoom} scale={zoom} fx={side === "right" ? "right" : "left"} />
    <Caption title={title} sub={sub} color={color} tag={tag} x={side === "right" ? 120 : 1010} y={330} w={840} />
  </AbsoluteFill>
);
type Duo = { a: string; b: string; speedA?: number; speedB?: number; title: string; sub?: string; color: string; labelA?: string; labelB?: string };
const DuoScene: React.FC<Duo> = ({ a, b, speedA, speedB, title, sub, color, labelA = "Развёрнутая", labelB = "Свёрнутая" }) => (
  <AbsoluteFill>
    <Caption title={title} sub={sub} color={color} x={160} y={26} w={1600} size={60} align="center" />
    {[[labelA, C.violet, 480], [labelB, C.green, 1440]].map(([t, c, cx], i) => (
      <div key={i} style={{ position: "absolute", left: (cx as number) - 200, top: 172, width: 400, textAlign: "center" }}>
        <span style={{ fontFamily: BODY, fontWeight: 700, fontSize: 28, color: "#241a3d", background: c as string, borderRadius: 30, padding: "8px 26px" }}>{t}</span>
      </div>
    ))}
    <Widget name={a} speed={speedA} x={150} y={204} scale={0.76} fx="left" />
    <Widget name={b} speed={speedB} x={1080} y={204} scale={0.76} fx="right" delay={5}
      skip={(s) => (SOUNDS[a] ?? []).some((o) => o.file === s.file && o.synth === s.synth && Math.abs(o.frame / (speedA ?? 1) - s.frame / (speedB ?? 1)) < 8)} />
    <div style={{ position: "absolute", left: 958, top: 330, width: 4, height: 600, borderRadius: 2, background: "linear-gradient(transparent, rgba(255,255,255,.28), transparent)" }} />
  </AbsoluteFill>
);

// --- полная версия: окно приложения с наклоном и наездом ---
const FullScene: React.FC<{ rec: string; speed: number; len: number; caps: { at: number; title: string; sub?: string; color: string }[] }> = ({ rec, speed, len, caps }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 16, stiffness: 120 } });
  const n = Math.min(LEN[rec] - 1, Math.round(f * speed));
  const tilt = interpolate(f, [0, len], [9, -5]);
  const zoom = interpolate(f, [0, len], [0.94, 1.03]);
  const cur = [...caps].reverse().find((c) => f >= c.at) ?? caps[0];
  return (
    <AbsoluteFill style={{ perspective: 2200 }}>
      <div style={{ position: "absolute", left: 250, top: 70, width: 1560, height: 878, borderRadius: 22, overflow: "hidden", background: "#fafafc",
        boxShadow: "0 50px 110px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.14)", opacity: s,
        transform: `translateY(${(1 - s) * 160}px) rotateY(${tilt}deg) rotateX(3deg) scale(${zoom})` }}>
        <Img src={staticFile(`rec/t_${rec}/${String(n).padStart(4, "0")}.png`)} style={{ width: "100%", height: "100%" }} />
      </div>
      <Sequence key={cur.at} from={cur.at} layout="none">
        <div style={{ position: "absolute", left: 70, bottom: 54, background: "rgba(22,17,40,.88)", border: "1px solid rgba(255,255,255,.14)", borderRadius: 28, padding: "26px 44px 34px", backdropFilter: "blur(12px)" }}>
          <Caption title={cur.title} sub={cur.sub} color={cur.color} x={0} y={0} w={1000} size={58} />
          <div style={{ visibility: "hidden", fontFamily: HEAD, fontSize: 58, lineHeight: 1.1, paddingTop: 36 }}>{cur.title}<div style={{ fontFamily: BODY, fontSize: 27, marginTop: 24 }}>{cur.sub ?? ""}</div></div>
        </div>
      </Sequence>
      <AppSounds rec={rec} speed={speed} />
    </AbsoluteFill>
  );
};

// --- начало: три удара по долям и она сама ---
const Hook: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lines = [{ t: "Забыл.", at: 0, c: C.pink }, { t: "Отложил.", at: 15, c: C.orange }, { t: "Не записал.", at: 30, c: C.yellow }];
  const fin = spring({ frame: f - 60, fps, config: { damping: 13, stiffness: 150 } });
  const up = spring({ frame: f - 56, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 140, top: 210 }}>
        {lines.map((l, i) => {
          const s = spring({ frame: f - l.at, fps, config: { damping: 11, stiffness: 220 } });
          const out = interpolate(f, [56, 66], [1, 0.32], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return <div key={i} style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 96, lineHeight: 1.14, color: l.c, opacity: s * out,
            transform: `translateX(${(1 - s) * -120}px) scale(${0.8 + 0.2 * s})`, transformOrigin: "left center", textDecoration: f > 60 ? "line-through" : "none" }}>{l.t}</div>;
        })}
        <div style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 60, color: C.ink, marginTop: 44, opacity: fin, transform: `translateY(${(1 - fin) * 50}px) scale(${0.9 + 0.1 * fin})`, transformOrigin: "left center" }}>
          Теперь у тебя есть она.
        </div>
      </div>
      <div style={{ position: "absolute", right: 90, bottom: -30, transform: `translateY(${(1 - up) * 700}px) rotate(${(1 - up) * 8}deg)` }}>
        <AnimatedImage src={staticFile("maid/hello.webp")} width={620} height={980} fit="contain" />
      </div>
      <Sequence from={56} layout="none"><Audio src={staticFile("sfx/hey.wav")} volume={0.8} /></Sequence>
    </AbsoluteFill>
  );
};

// --- финал ---
const Cta: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f - 4, fps, config: { damping: 13 } });
  const t = spring({ frame: f - 8, fps, config: { damping: 11, stiffness: 160 } });
  const u = spring({ frame: f - 30, fps, config: { damping: 18 } });
  const chips = ["27 живых анимаций", "Задачи и привычки", "Дневник и сон", "Напоминания"];
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", right: 110, bottom: -20, transform: `translateY(${(1 - s) * 500}px)` }}>
        <AnimatedImage src={staticFile("maid/hello.webp")} width={600} height={960} fit="contain" />
      </div>
      <div style={{ position: "absolute", left: 130, top: 230, width: 1200 }}>
        <div style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 138, lineHeight: 1.02, color: C.ink, letterSpacing: -3, opacity: t, transform: `scale(${0.8 + 0.2 * t})`, transformOrigin: "left center" }}>
          Твоя<br />горничная
        </div>
        <div style={{ fontFamily: BODY, fontWeight: 500, fontSize: 42, color: C.soft, marginTop: 26, opacity: u }}>Помнит всё за тебя. И немного подкалывает.</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 34, width: 1000 }}>
          {chips.map((c, i) => {
            const k = spring({ frame: f - 44 - i * 5, fps, config: { damping: 14 } });
            return <div key={c} style={{ fontFamily: BODY, fontWeight: 700, fontSize: 28, color: C.ink, background: "rgba(255,255,255,.1)", border: "1px solid rgba(255,255,255,.18)",
              borderRadius: 40, padding: "10px 24px", opacity: k, transform: `translateY(${(1 - k) * 24}px)` }}>{c}</div>;
          })}
        </div>
        <div style={{ display: "inline-block", fontFamily: BODY, fontWeight: 700, fontSize: 40, color: "#241a3d", background: C.violet, borderRadius: 50, padding: "20px 46px", marginTop: 44,
          opacity: u, transform: `translateY(${(1 - u) * 30}px)`, boxShadow: "0 16px 40px rgba(183,156,255,.4)" }}>Добавь в список желаемого ✨</div>
      </div>
    </AbsoluteFill>
  );
};

// --- сцены по тактам ---
type Scene = { id: string; bars: number; el: React.ReactNode; cut?: "whoosh" | "none" };
const N = (bars: number) => bars * BAR;
const SCENES: Scene[] = [
  { id: "hook", bars: 2, cut: "none", el: <Hook /> },
  { id: "hello", bars: 2, el: <DuoScene a="hello_open" b="hello_fold" title="Живёт на твоём рабочем столе" sub="Развёрнутая — со всеми делами. Свёрнутая — маленькая карточка в углу" color={C.violet} /> },
  { id: "poke", bars: 3, el: <SoloScene rec="poke" speed={228 / N(3)} side="right" title="Её можно тыкать" sub="Но на десятый раз она обидится" color={C.pink} /> },
  { id: "write", bars: 4, el: <DuoScene a="write_open" b="write_fold" speedA={300 / N(4)} speedB={1} title="Пиши как другу — разложит сама" sub="План, задача и день рождения из одной фразы" color={C.green} /> },
  { id: "cancel", bars: 4, el: <SoloScene rec="cancel" speed={315 / N(4)} side="left" title="Передумал? В корзину" sub="«Отмени» — план улетает. «Верни» — возвращается" color={C.orange} /> },
  { id: "clash", bars: 3, el: <SoloScene rec="clash" speed={240 / N(3)} zoom={1.0} side="right" title="Планы столкнулись?" sub="Заметит и сама предложит сдвинуть" color={C.blue} /> },
  { id: "diary", bars: 2, el: <FullScene rec="full_diary" speed={1.5} len={N(2)} caps={[{ at: 0, title: "А внутри — вся твоя жизнь", sub: "Дневник: каждый день месяца одним взглядом", color: C.violet }]} /> },
  { id: "stats", bars: 3, el: <FullScene rec="full_stats" speed={240 / N(3)} len={N(3)} caps={[{ at: 0, title: "Сколько ты за компьютером", sub: "И сколько из этого — игры", color: C.pink },
    { at: 96, title: "И когда ты ложишься", sub: "Сон за месяц: отбой, подъём, среднее", color: C.blue }]} /> },
  { id: "remind", bars: 2, el: <DuoScene a="remind_open" b="remind_fold" title="Не даст забыть" sub="За десять минут до плана достаёт часики" color={C.orange} /> },
  { id: "lazy", bars: 2, el: <DuoScene a="angry" b="clean" title="И не даст отлынивать" sub="Просрочил — сердится. День не задался — грустно метёт" color={C.pink} labelA="Просрочено" labelB="Плохой день" /> },
  { id: "done", bars: 3, el: <SoloScene rec="done" speed={270 / N(3)} side="left" title="Зато как она радуется" sub="Чпок — задача сделана. Серия привычки растёт" color={C.green} /> },
  { id: "sleep", bars: 3, el: <SoloScene rec="sleep" speed={240 / N(3)} side="right" title="Ушёл — она спит" sub="Вернулся — проснётся и расскажет, что было" color={C.blue} /> },
  { id: "thanks", bars: 2, el: <SoloScene rec="thanks" speed={195 / N(2)} side="left" title="Скажи ей «спасибо»" sub="Ей приятно" color={C.pink} /> },
  { id: "games", bars: 2, el: <SoloScene rec="games" from={0} zoom={1.3} side="right" title="Заигрался?" sub="Она заметит" color={C.orange} /> },
  { id: "girl", bars: 5, el: <SoloScene rec="girl" speed={GIRL_FLASH / N(5)} side="left" title="У неё есть характер" sub="И она умеет хранить секреты" color={C.violet} /> },
  { id: "cta", bars: 3.5, cut: "none", el: <Cta /> },
];
const starts: number[] = [];
let acc = 0;
for (const s of SCENES) { starts.push(acc); acc += N(s.bars); }
export const TRAILER_TOTAL = acc;
const FLASH_AT = starts[SCENES.length - 1];

const SceneView: React.FC<{ len: number; children: React.ReactNode }> = ({ len, children }) => {
  const f = useCurrentFrame();
  const out = interpolate(f, [len - 5, len], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: out, transform: `scale(${1 + (1 - out) * 0.04})` }}>{children}</AbsoluteFill>;
};

// Вспышка прибора на весь экран: из неё выходит финал.
const Flash: React.FC = () => {
  const f = useCurrentFrame();
  const op = interpolate(f, [FLASH_AT - 3, FLASH_AT, FLASH_AT + 8, FLASH_AT + 34], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return op > 0 ? <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 50%, #fff 0%, #eaf3ff 60%, #cfe2ff 100%)", opacity: op }} /> : null;
};

export const Trailer: React.FC = () => (
  <AbsoluteFill style={{ background: "#1b1630" }}>
    <Desktop />
    {SCENES.map((s, i) => (
      <Sequence key={s.id} from={starts[i]} durationInFrames={N(s.bars)} layout="none">
        <SceneView len={i === SCENES.length - 1 ? 99999 : N(s.bars)}>{s.el}</SceneView>
        {s.cut !== "none" ? <Sequence from={-5} layout="none"><Audio src={staticFile("sfx/whoosh.wav")} volume={0.35} /></Sequence> : null}
      </Sequence>
    ))}
    <Flash />
    <Audio src={staticFile("sfx/trailer.mp3")} volume={0.38} />
  </AbsoluteFill>
);
