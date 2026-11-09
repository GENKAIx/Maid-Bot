// Ролик-презентация «Горничной» на ПК: настоящий виджет, записанный кадр за кадром (tools/record.mjs → public/rec),
// на рабочем столе, слева — подписи. Сцены и их длительность — SCENES; звуки — метки записи + те, что виджет играл сам.
import React from "react";
import { AbsoluteFill, AnimatedImage, Easing, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { loadFont as loadUnbounded } from "@remotion/google-fonts/Unbounded";
import { loadFont as loadManrope } from "@remotion/google-fonts/Manrope";

const { fontFamily: HEAD } = loadUnbounded("normal", { weights: ["800"], subsets: ["cyrillic", "latin"] });
const { fontFamily: BODY } = loadManrope("normal", { weights: ["500", "700"], subsets: ["cyrillic", "latin"] });

const C = { ink: "#fff6ec", soft: "rgba(255,246,236,.72)", violet: "#b79cff", green: "#4fd09a", orange: "#ffb36b", pink: "#ff8a9a", blue: "#7cc4ff", yellow: "#ffe27a" };
const FADE = 10;

// Записанный виджет: кадр 990×1170 (страница 660×780 ×1,5) → на экране ×0,85.
const K = 0.85;
const REC_W = 990 * K, REC_H = 1170 * K;
const REC_X = 1060, REC_Y = 52;
const REC_LEN: Record<string, number> = { intro: 165, chat: 270, remind: 210, finish: 225, clock: 180, inbox: 195, task: 135, poke: 255, night: 120, games: 150 };

type Mark = { at: number; sfx: string; vol?: number };
type Scene = { id: string; len: number; rec?: string; from?: number; title?: string; sub?: string; color?: string;
  focus?: [number, number]; zoom?: number; marks?: Mark[]; custom?: React.FC };

const pops = (start: number, n: number, gap: number, vol = 0.5): Mark[] => Array.from({ length: n }, (_, i) => ({ at: start + i * gap, sfx: "pop", vol }));

const Hook: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lines = [
    { t: "Опять забыл выпить таблетки?", at: 0 },
    { t: "Позвонить маме?", at: 22 },
    { t: "Записать, сколько спал?", at: 40 },
  ];
  return (
    <AbsoluteFill style={{ alignItems: "flex-start", justifyContent: "center", paddingLeft: 160 }}>
      {lines.map((l, i) => {
        const s = spring({ frame: f - l.at, fps, config: { damping: 14, stiffness: 170 } });
        return <div key={i} style={{ fontFamily: HEAD, fontWeight: 800, fontSize: i === 0 ? 88 : 66, color: C.ink, opacity: s * (i === 0 ? 1 : 0.78),
          transform: `translateX(${(1 - s) * -60}px)`, lineHeight: 1.2, marginBottom: 14 }}>{l.t}</div>;
      })}
      <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: 42, color: C.violet, marginTop: 34,
        opacity: spring({ frame: f - 58, fps, config: { damping: 18 } }) }}>Есть та, кто не забудет.</div>
    </AbsoluteFill>
  );
};

const SCENES: Scene[] = [
  { id: "hook", len: 88, custom: Hook },
  { id: "intro", len: 160, rec: "intro", title: "Знакомься: горничная", sub: "Живёт в углу экрана и помнит всё за тебя", color: C.violet,
    focus: [945, 640], zoom: 1.05, marks: [{ at: 12, sfx: "hey" }, { at: 84, sfx: "pop" }] },
  { id: "chat", len: 260, rec: "chat", title: "Пиши как другу", sub: "Одна фраза — а она сама разложит: сон, здоровье, планы", color: C.green,
    focus: [945, 520], zoom: 1.18, marks: [{ at: 99, sfx: "send" }, { at: 138, sfx: "ding" }, ...pops(143, 4, 4)] },
  { id: "remind", len: 190, rec: "remind", title: "Напомнит вовремя", sub: "А отметить — одна кнопка", color: C.orange,
    focus: [945, 420], zoom: 1.2, marks: [{ at: 9, sfx: "hey" }, { at: 84, sfx: "pop", vol: 0.8 }, { at: 100, sfx: "pop", vol: 0.6 }] },
  { id: "finish", len: 215, rec: "finish", title: "Курс таблеток — как поп-ит", sub: "Лопай пупырку каждый день. В конце — салют и медаль", color: C.pink,
    focus: [945, 260], zoom: 1.28, marks: [{ at: 30, sfx: "pop", vol: 0.8 }, ...pops(52, 6, 2, 0.35), { at: 66, sfx: "ding" }] },
  { id: "clock", len: 170, rec: "clock", title: "Весь день — одним взглядом", sub: "Планы дугами на часах или списком, важные даты сверху", color: C.blue,
    focus: [945, 700], zoom: 1.12, marks: [{ at: 96, sfx: "pop", vol: 0.4 }] },
  { id: "inbox", len: 190, rec: "inbox", title: "Отошёл от компьютера?", sub: "Пропущенное ждёт тебя — каждое своим значком", color: C.yellow,
    focus: [945, 430], zoom: 1.22, marks: [{ at: 9, sfx: "pop" }, { at: 27, sfx: "pop" }, { at: 45, sfx: "pop" }, { at: 63, sfx: "pop" }, { at: 114, sfx: "hey" }] },
  { id: "task", len: 120, rec: "task", title: "Сделал — чпок!", sub: "Задача уезжает вниз, горничная радуется", color: C.green,
    focus: [945, 860], zoom: 1.22, marks: [{ at: 18, sfx: "pop", vol: 0.9 }] },
  { id: "poke", len: 250, rec: "poke", title: "А ещё её можно тыкать", sub: "Только не больше десяти раз…", color: C.pink,
    focus: [945, 360], zoom: 1.25, marks: [...Array.from({ length: 9 }, (_, i) => ({ at: 12 + i * 18, sfx: "pop", vol: 0.45 })), { at: 174, sfx: "oops", vol: 0.9 }] },
  { id: "moods", len: 160, custom: () => <Moods /> },
  { id: "night", len: 95, rec: "night", title: "Ночью она спит", sub: "Тссс…", color: C.blue, focus: [945, 640], zoom: 1.15 },
  { id: "games", len: 140, rec: "games", title: "Засиделся в игре?", sub: "Заметит, напомнит про перерыв и заварит чай", color: C.orange,
    focus: [945, 380], zoom: 1.2, marks: [{ at: 9, sfx: "hey" }] },
  { id: "everywhere", len: 165, custom: () => <Everywhere /> },
  { id: "cta", len: 170, custom: () => <Cta /> },
];
const starts: number[] = [];
let acc = 0;
for (const s of SCENES) { starts.push(acc); acc += s.len - FADE; }
export const TOTAL = acc + FADE;

// --- рабочий стол ---
const Desktop: React.FC = () => {
  const f = useCurrentFrame();
  const blobs = [
    { x: 380, y: 260, r: 520, c: "rgba(183,156,255,.38)", sp: 0.004 },
    { x: 1500, y: 180, r: 460, c: "rgba(124,196,255,.22)", sp: 0.003 },
    { x: 900, y: 980, r: 640, c: "rgba(255,138,154,.20)", sp: 0.0025 },
  ];
  return (
    <AbsoluteFill style={{ background: "linear-gradient(160deg,#241a3d 0%,#2c2552 45%,#1b2340 100%)", overflow: "hidden" }}>
      {blobs.map((b, i) => (
        <div key={i} style={{ position: "absolute", left: b.x - b.r + Math.sin(f * b.sp * 6 + i) * 60, top: b.y - b.r + Math.cos(f * b.sp * 5 + i) * 40,
          width: b.r * 2, height: b.r * 2, borderRadius: "50%", background: `radial-gradient(circle, ${b.c}, transparent 65%)` }} />
      ))}
      <AbsoluteFill style={{ opacity: 0.06, backgroundImage: "radial-gradient(rgba(255,255,255,.9) 1px, transparent 1.4px)", backgroundSize: "26px 26px" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 48, background: "rgba(16,13,30,.78)", borderTop: "1px solid rgba(255,255,255,.08)",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 14 }}>
        {["#7cc4ff", "#ffb36b", "#4fd09a", "#b79cff", "#ff8a9a"].map((c, i) => (
          <div key={i} style={{ width: 28, height: 28, borderRadius: 7, background: c, opacity: 0.75 }} />
        ))}
        <div style={{ position: "absolute", right: 22, color: C.soft, fontFamily: BODY, fontSize: 15, textAlign: "right", lineHeight: 1.15 }}>18:40<br />08.11</div>
      </div>
    </AbsoluteFill>
  );
};

// --- записанный виджет ---
const Rec: React.FC<{ name: string; from?: number; len: number; focus?: [number, number]; zoom?: number }> = ({ name, from = 0, len, focus = [700, 600], zoom = 1 }) => {
  const f = useCurrentFrame();
  const n = Math.min(REC_LEN[name] - 1, Math.max(0, from + f));
  const z = interpolate(f, [0, 40, len], [1, zoom, zoom * 1.015], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  const ox = REC_X + focus[0] * K, oy = REC_Y + focus[1] * K;
  return (
    <AbsoluteFill style={{ transform: `scale(${z})`, transformOrigin: `${ox}px ${oy}px` }}>
      <Img src={staticFile(`rec/${name}/${String(n).padStart(4, "0")}.png`)}
        style={{ position: "absolute", left: REC_X, top: REC_Y, width: REC_W, height: REC_H, filter: "drop-shadow(0 30px 50px rgba(0,0,0,.35))" }} />
    </AbsoluteFill>
  );
};

// --- подписи слева ---
const Caption: React.FC<{ title: string; sub?: string; color: string; len: number }> = ({ title, sub, color, len }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = title.split(" ");
  const subIn = spring({ frame: f - 10 - words.length * 3, fps, config: { damping: 18 } });
  const bar = spring({ frame: f - 4, fps, config: { damping: 20 } });
  return (
    <div style={{ position: "absolute", left: 120, top: 330, width: 860 }}>
      <div style={{ width: 90 * bar, height: 10, borderRadius: 5, background: color, marginBottom: 34 }} />
      <div style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 76, lineHeight: 1.1, color: C.ink, letterSpacing: -1 }}>
        {words.map((w, i) => {
          const s = spring({ frame: f - 6 - i * 3, fps, config: { damping: 13, stiffness: 160 } });
          return <span key={i} style={{ display: "inline-block", marginRight: 22, transform: `translateY(${(1 - s) * 50}px) rotate(${(1 - s) * -6}deg)`, opacity: s }}>{w}</span>;
        })}
      </div>
      {sub ? <div style={{ fontFamily: BODY, fontWeight: 500, fontSize: 36, lineHeight: 1.35, color: C.soft, marginTop: 30, maxWidth: 760,
        opacity: subIn, transform: `translateY(${(1 - subIn) * 20}px)` }}>{sub}</div> : null}
    </div>
  );
};

// --- все анимации горничной ---
const MOODS: [string, string][] = [["hello", "привет"], ["tea", "пьёт чай"], ["clean", "метёт"], ["proud", "гордится"], ["think", "думает"],
  ["streak", "серия!"], ["write", "записывает"], ["angry", "обиделась"], ["sleep", "спит"], ["bow", "кланяется"]];
const Moods: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Caption title="20 живых анимаций" sub="Дышит, моргает и живёт своей жизнью" color={C.violet} len={160} />
      <div style={{ position: "absolute", left: 1010, top: 150, width: 860, display: "grid", gridTemplateColumns: "repeat(5, 1fr)", rowGap: 26 }}>
        {MOODS.map(([m, label], i) => {
          const s = spring({ frame: f - 8 - i * 4, fps, config: { damping: 12, stiffness: 150 } });
          return (
            <div key={m} style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: `scale(${s})`, opacity: s }}>
              <AnimatedImage src={staticFile(`maid/${m}.webp`)} width={164} height={300} fit="contain" />
              <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: 24, color: C.soft, marginTop: 4 }}>{label}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// --- из любой программы ---
const Key: React.FC<{ k: string; at: number }> = ({ k, at }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f - at, fps, config: { damping: 12 } });
  const press = interpolate(f, [at + 30, at + 34, at + 42], [0, 8, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <div style={{ fontFamily: BODY, fontWeight: 700, fontSize: 44, color: "#2a2147", background: C.ink, borderRadius: 18, padding: "18px 34px",
    boxShadow: `0 ${10 - press}px 0 #b8a9d9`, transform: `translateY(${press}px) scale(${s})` }}>{k}</div>;
};
const Everywhere: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chips = [["🎙", "Голосом"], ["✈️", "Из Telegram"], ["📱", "С телефона"], ["🎮", "Следит за играми"]];
  return (
    <AbsoluteFill>
      <Caption title="Из любой программы" sub="Нажал, сказал — готово. Всё сразу и в Telegram, и на телефоне" color={C.blue} len={165} />
      <div style={{ position: "absolute", left: 1080, top: 320, display: "flex", gap: 20, alignItems: "center" }}>
        <Key k="Alt" at={6} /><span style={{ color: C.soft, fontSize: 40, fontFamily: BODY }}>+</span>
        <Key k="Shift" at={10} /><span style={{ color: C.soft, fontSize: 40, fontFamily: BODY }}>+</span>
        <Key k="Space" at={14} />
      </div>
      <div style={{ position: "absolute", left: 1080, top: 490, display: "flex", flexWrap: "wrap", gap: 18, width: 720 }}>
        {chips.map(([i, t], k) => {
          const s = spring({ frame: f - 50 - k * 8, fps, config: { damping: 14 } });
          return <div key={t} style={{ fontFamily: BODY, fontWeight: 700, fontSize: 32, color: C.ink, background: "rgba(255,255,255,.1)",
            border: "1px solid rgba(255,255,255,.16)", borderRadius: 40, padding: "14px 28px", opacity: s, transform: `translateY(${(1 - s) * 30}px)` }}>{i} {t}</div>;
        })}
      </div>
      <Sequence from={44} layout="none"><Audio src={staticFile("sfx/send.wav")} volume={0.6} /></Sequence>
    </AbsoluteFill>
  );
};

// --- финал ---
const Cta: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 14 } });
  const t = spring({ frame: f - 12, fps, config: { damping: 16 } });
  const u = spring({ frame: f - 30, fps, config: { damping: 18 } });
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", right: 120, bottom: 48, transform: `translateY(${(1 - s) * 400}px)` }}>
        <AnimatedImage src={staticFile("maid/hello.webp")} width={560} height={920} fit="contain" />
      </div>
      <div style={{ position: "absolute", left: 140, top: 290, width: 1150 }}>
        <div style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 140, color: C.ink, letterSpacing: -3, opacity: t, transform: `scale(${0.85 + 0.15 * t})`, transformOrigin: "left center" }}>Горничная</div>
        <div style={{ fontFamily: BODY, fontWeight: 500, fontSize: 44, color: C.soft, marginTop: 18, opacity: u }}>Маленькая помощница на твоём рабочем столе</div>
        <div style={{ display: "inline-block", fontFamily: BODY, fontWeight: 700, fontSize: 38, color: "#2a2147", background: C.violet, borderRadius: 50,
          padding: "20px 44px", marginTop: 54, opacity: u, transform: `translateY(${(1 - u) * 30}px)` }}>Попробуй — она уже ждёт ✨</div>
      </div>
      <Sequence from={4} layout="none"><Audio src={staticFile("sfx/hey.wav")} volume={0.7} /></Sequence>
    </AbsoluteFill>
  );
};

// --- сборка ---
const SceneView: React.FC<{ s: Scene }> = ({ s }) => {
  const f = useCurrentFrame();
  const op = interpolate(f, [0, FADE, s.len - FADE, s.len], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const Custom = s.custom;
  return (
    <AbsoluteFill style={{ opacity: op }}>
      {s.rec ? <Rec name={s.rec} from={s.from} len={s.len} focus={s.focus} zoom={s.zoom} /> : null}
      {s.title ? <Caption title={s.title} sub={s.sub} color={s.color ?? C.violet} len={s.len} /> : null}
      {Custom ? <Custom /> : null}
      {(s.marks ?? []).map((m, i) => (
        <Sequence key={i} from={m.at} layout="none"><Audio src={staticFile(`sfx/${m.sfx}.wav`)} volume={m.vol ?? 0.7} /></Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const Promo: React.FC = () => (
  <AbsoluteFill style={{ background: "#1b1630" }}>
    <Desktop />
    {SCENES.map((s, i) => (
      <Sequence key={s.id} from={starts[i]} durationInFrames={s.len} layout="none"><SceneView s={s} /></Sequence>
    ))}
    <Audio src={staticFile("sfx/music.mp3")} volume={(fr) => interpolate(fr, [0, 20, TOTAL - 60, TOTAL], [0, 0.2, 0.2, 0], { extrapolateRight: "clamp" })} />
  </AbsoluteFill>
);
