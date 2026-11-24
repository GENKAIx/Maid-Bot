import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { FEATURES as SCENES, demoLength, type Demo } from "../features";
import { REGISTRY } from "../registry.gen";
import { recolorIsOwn, recolorPixels, SHOW_EYES, SHOW_HAIR, type RecolorOption } from "../recolor";
import { ANIM_GROUPS, animWhen, frameStart, PLAYER_SPEEDS, playerStep, secText, sizeText, usageIndex, usedCount, type AnimGroup, type AnimInfo, type UsageNum } from "../showcase";
import { navigate } from "../router";
import { Loading, useAdmin } from "./AdminSections";

// «Витрина» админки (этап 4, 24.11.2026) — свой кусок (lazy в Admin.tsx): анимации Рины с проигрывателем и перекраской,
// эффекты виджета списком (живой показ — только походка букв), сценарии «Возможностей», карта функций с числами этапа 3.
// Всё — из реестра web/src/registry.gen.ts (tools/registry/make_registry.ts) и готовых картинок /maid/*.webp, без своих копий.

type Tab = "anims" | "fx" | "scenes" | "map";
const TABS: { id: Tab; title: string }[] = [
  { id: "anims", title: `Анимации ${REGISTRY.anims.length}` },
  { id: "fx", title: "Эффекты" },
  { id: "scenes", title: `Сценарии ${SCENES.length}` },
  { id: "map", title: "Карта функций" },
];

export function AdminShowcase() {
  const [tab, setTab] = useState<Tab>("anims");
  const [pick, setPick] = useState("idle");
  const open = (id: string) => { setPick(id); setTab("anims"); };
  return (
    <>
      <div className="adm-toolbar">
        <div className="adm-seg-ctl" role="tablist" aria-label="Витрина">
          {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>{t.title}</button>)}
        </div>
      </div>
      {tab === "anims" ? <Anims pick={pick} onPick={setPick} />
        : tab === "fx" ? <Effects />
        : tab === "scenes" ? <Scenes onAnim={open} />
        : <FunctionMap />}
    </>
  );
}

// ——— Анимации: сетка и проигрыватель.

function Anims({ pick, onPick }: { pick: string; onPick: (id: string) => void }) {
  const [group, setGroup] = useState<"all" | AnimGroup>("all");
  const [hair, setHair] = useState("red");
  const [eyes, setEyes] = useState("violet");
  const anim = REGISTRY.anims.find((a) => a.id === pick) ?? REGISTRY.anims[0];
  const list = REGISTRY.anims.filter((a) => group === "all" || a.group === group);
  return (
    <>
      <section className="adm-player">
        <Player key={anim.id} anim={anim} hair={hair} eyes={eyes} />
        <div className="adm-player-side">
          <Swatches title="Волосы" table={SHOW_HAIR} value={hair} onChange={setHair} />
          <Swatches title="Глаза" table={SHOW_EYES} value={eyes} onChange={setEyes} />
          <p className="adm-muted adm-small">
            Перекраска — те же формулы, что у виджета (look.js), но без маски: у картинок сайта её нет, поэтому румянец и рот тоже
            чуть меняют цвет. Звука здесь нет — звуки эмоций синтезирует сам виджет (moodsound.js).
          </p>
        </div>
      </section>
      <div className="adm-toolbar">
        <div className="adm-seg-ctl" role="tablist" aria-label="Группа">
          {(["all", "base", "event", "once"] as const).map((g) => (
            <button key={g} role="tab" aria-selected={group === g} className={group === g ? "on" : ""} onClick={() => setGroup(g)}>
              {g === "all" ? "Все" : ANIM_GROUPS[g]} <span className="adm-muted">{g === "all" ? REGISTRY.anims.length : REGISTRY.anims.filter((a) => a.group === g).length}</span>
            </button>
          ))}
        </div>
        <span className="adm-muted adm-small">группы — по baseMood() в widget.js; кадры и длительность — картинок сайта</span>
      </div>
      <div className="adm-anims">
        {list.map((a) => (
          <button key={a.id} className={`adm-anim ${a.id === anim.id ? "on" : ""}`} onClick={() => onPick(a.id)} aria-pressed={a.id === anim.id}>
            <img src={`/maid/${a.id}.webp`} alt="" width={90} height={96} loading="lazy" />
            <b>{a.name}</b>
            <span className="adm-num adm-muted">{a.id}</span>
            <span className="adm-num adm-muted">{a.frames} кадр. · {secText(a.ms)}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function Swatches({ title, table, value, onChange }: { title: string; table: RecolorOption[]; value: string; onChange: (id: string) => void }) {
  const cur = table.find((o) => o.id === value) ?? table[0];
  return (
    <div className="adm-sw">
      <h3>{title} <span className="adm-muted">{cur.name}</span></h3>
      <div role="radiogroup" aria-label={title}>
        {table.map((o) => (
          <button key={o.id} role="radio" aria-checked={o.id === value} title={o.name} aria-label={o.name}
            className={o.id === value ? "on" : ""} style={{ background: o.swatch }} onClick={() => onChange(o.id)} />
        ))}
      </div>
    </div>
  );
}

type Decoded = { frames: ImageData[]; durations: number[] };
const canDecode = () => typeof window !== "undefined" && "ImageDecoder" in window;
// Разобранные анимации — несколько последних (кадр 180×192 — 138 КБ, анимация — до 9 МБ в памяти).
const decoded = new Map<string, Promise<Decoded>>();
function decodeAnim(id: string): Promise<Decoded> {
  const had = decoded.get(id);
  if (had) return had;
  const p = (async () => {
    const r = await fetch(`/maid/${id}.webp`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const dec = new ImageDecoder({ data: await r.arrayBuffer(), type: "image/webp", colorSpaceConversion: "none" });
    try {
      await dec.tracks.ready;
      await dec.completed;
      const n = dec.tracks.selectedTrack?.frameCount ?? 0;
      const frames: ImageData[] = [], durations: number[] = [];
      let ctx: OffscreenCanvasRenderingContext2D | null = null;
      for (let i = 0; i < n; i++) {
        const fr = (await dec.decode({ frameIndex: i })).image;
        try {
          ctx ??= new OffscreenCanvas(fr.displayWidth, fr.displayHeight).getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("нет холста");
          ctx.clearRect(0, 0, fr.displayWidth, fr.displayHeight);
          ctx.drawImage(fr, 0, 0);
          frames.push(ctx.getImageData(0, 0, fr.displayWidth, fr.displayHeight));
          durations.push(Math.max(1, Math.round((fr.duration ?? 83_000) / 1000)));
        } finally {
          fr.close();
        }
      }
      if (!frames.length) throw new Error("нет кадров");
      return { frames, durations };
    } finally {
      dec.close();
    }
  })();
  decoded.set(id, p);
  p.catch(() => decoded.delete(id));
  while (decoded.size > 4) decoded.delete(decoded.keys().next().value!);
  return p;
}

function Player({ anim, hair, eyes }: { anim: AnimInfo; hair: string; eyes: string }) {
  const [dec, setDec] = useState<Decoded | null>(null);
  const [err, setErr] = useState(canDecode() ? "" : "браузер не раскладывает WebP на кадры (нет ImageDecoder)");
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(anim.group !== "once");
  const pos = useRef({ i: 0, carry: 0 });
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canDecode()) return;
    let alive = true;
    decodeAnim(anim.id).then((d) => alive && setDec(d)).catch((e) => alive && setErr((e as Error).message || "не разобралась"));
    return () => { alive = false; };
  }, [anim.id]);

  // Кадры в выбранных цветах: копия исходных, перекрашенная целиком (36–66 кадров по 34 560 точек — доли секунды).
  const shown = useMemo(() => {
    if (!dec || recolorIsOwn(hair, eyes)) return dec?.frames ?? null;
    return dec.frames.map((f) => {
      const c = new ImageData(new Uint8ClampedArray(f.data), f.width, f.height);
      recolorPixels(c.data, hair, eyes);
      return c;
    });
  }, [dec, hair, eyes]);

  useEffect(() => {
    if (!dec || !playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const r = playerStep(dec.durations, pos.current.i, pos.current.carry, (now - last) * speed, loop);
      last = now;
      pos.current = { i: r.i, carry: r.carry };
      setIdx(r.i);
      if (r.end) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dec, playing, speed, loop]);

  useEffect(() => {
    const f = shown?.[idx], ctx = canvas.current?.getContext("2d");
    if (f && ctx) ctx.putImageData(f, 0, 0);
  }, [shown, idx]);

  const n = dec?.frames.length ?? anim.frames;
  const seek = (i: number) => {
    const k = Math.min(Math.max(i, 0), n - 1);
    pos.current = { i: k, carry: 0 };
    setIdx(k);
  };
  const toggle = () => {
    if (!playing && !loop && idx >= n - 1) seek(0); // доиграла один раз — с начала
    setPlaying(!playing);
  };
  const keys = (e: KeyboardEvent) => {
    if (!dec) return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); seek(idx + (e.key === "ArrowLeft" ? -1 : 1)); }
  };
  const t = dec ? frameStart(dec.durations, idx) : 0;

  return (
    <div className="adm-pl" tabIndex={0} onKeyDown={keys} aria-label={`Проигрыватель: ${anim.name}`}>
      <div className="adm-pl-view">
        {dec && shown ? <canvas ref={canvas} width={shown[0].width} height={shown[0].height} />
          : err ? <img src={`/maid/${anim.id}.webp`} alt={anim.name} width={anim.w} height={anim.h} />
          : <span className="adm-muted">Раскладываю на кадры…</span>}
      </div>
      <div className="adm-player-info">
        <h2>{anim.name} <span className="adm-muted adm-num">{anim.id}</span></h2>
        <dl>
          <dt>Когда играет</dt><dd>{animWhen(anim)}</dd>
          {anim.emotions.length > 0 && <><dt>Эмоции ответа</dt><dd className="adm-num">{anim.emotions.join(", ")}</dd></>}
          <dt>Кадров</dt><dd className="adm-num">{anim.frames} на сайте · {anim.desk.frames} в виджете</dd>
          <dt>Длительность</dt><dd className="adm-num">{secText(anim.ms)}{anim.group === "once" ? " · один раз" : " · по кругу"}</dd>
          <dt>Холст</dt><dd className="adm-num">{anim.w}×{anim.h} · в виджете {anim.desk.w}×{anim.desk.h}</dd>
          <dt>Файл</dt><dd className="adm-num">{sizeText(anim.bytes)}</dd>
        </dl>
        {err ? (
          <p className="adm-muted adm-small">Покадрово не показать: {err}. Картинка идёт сама, без шагов, скорости и перекраски.</p>
        ) : (
          <>
            <div className="adm-row">
              <button className="adm-btn small" onClick={() => { setPlaying(false); seek(idx - 1); }} disabled={!dec} title="Кадр назад (←)">◀︎ кадр</button>
              <button className="adm-btn small primary" onClick={toggle} disabled={!dec} title="Пробел">{playing ? "❚❚ пауза" : "▶ играть"}</button>
              <button className="adm-btn small" onClick={() => { setPlaying(false); seek(idx + 1); }} disabled={!dec} title="Кадр вперёд (→)">кадр ▶︎</button>
              <button className={`adm-btn small ${loop ? "on" : ""}`} aria-pressed={loop} onClick={() => setLoop(!loop)}>↻ по кругу</button>
            </div>
            <input className="adm-range" type="range" min={0} max={n - 1} value={idx} disabled={!dec} aria-label="Кадр"
              onChange={(e) => { setPlaying(false); seek(Number(e.target.value)); }} />
            <div className="adm-row adm-player-foot">
              <span className="adm-num">кадр {idx + 1} / {n} · {secText(t)}{dec ? ` · ${dec.durations[idx]} мс` : ""}</span>
              <div className="adm-seg-ctl" role="tablist" aria-label="Скорость">
                {PLAYER_SPEEDS.map((s) => <button key={s} role="tab" aria-selected={speed === s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>{s}×</button>)}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ——— Эффекты виджета: список из реестра; живьём — только походка букв (её ключевые кадры скопированы из style.css).

const GAIT_WORD = "Записала";

function Effects() {
  const fx = REGISTRY.effects;
  const [run, setRun] = useState(0);
  const css = fx.gait.map((g) => `@keyframes adm-gait-${g.id} { ${g.keyframes} }\n.adm-gait-${g.id} > span { animation: adm-gait-${g.id} ${g.animation}; animation-delay: calc(var(--i) * 70ms); }`).join("\n");
  return (
    <>
      <p className="adm-muted adm-note adm-fx-why">
        Живого показа виджета здесь нет: окна программы работают только в Electron (им нужен preload с <code>window.maid</code>), а сайт
        собирается без папки <code>desktop</code>. Описания — из комментариев в коде эффектов, собирает их скрипт реестра.
      </p>
      <h2 className="adm-h2">Походка букв <span className="adm-muted">· {fx.gait.length} · style.css</span></h2>
      <style>{css}</style>
      <div className="adm-gaits">
        {fx.gait.map((g) => (
          <div key={g.id} className="adm-gait-card">
            <div key={run} className={`adm-gait-word adm-gait-${g.id}`} aria-label={GAIT_WORD}>
              {[...GAIT_WORD].map((ch, i) => <span key={i} style={{ "--i": i } as CSSProperties}>{ch}</span>)}
            </div>
            <b className="adm-num">{g.id}</b>
            <span className="adm-muted adm-small">{g.emotions.join(", ")}</span>
          </div>
        ))}
      </div>
      <button className="adm-btn small" onClick={() => setRun(run + 1)}>▶ ещё раз</button>
      <FxList title="Слова с характером" src="wordfx.js" rows={fx.wordfx.map((x) => ({ id: x.id, name: `[${x.ru}]`, text: x.text }))} />
      <FxList title="Облачко" src="bubblefx.js" rows={fx.bubble.map((x) => ({ id: x.id, name: x.kind === "mark" ? "значок" : "облачко", text: x.text }))} />
      <FxList title="Погода над панелью" src="weather.js, style.css" rows={fx.weather.map((x) => ({ id: x.id, name: "", text: x.text }))} />
      <FxList title="Праздники привычек" src="habitparty.js" rows={fx.holidays.map((x) => ({ id: x.title, name: "", text: x.text }))} />
    </>
  );
}

function FxList({ title, src, rows }: { title: string; src: string; rows: { id: string; name: string; text: string }[] }) {
  return (
    <>
      <h2 className="adm-h2">{title} <span className="adm-muted">· {rows.length} · {src}</span></h2>
      <div className="adm-fx">
        {rows.map((r) => (
          <div key={r.id} className="adm-fx-row">
            <b className="adm-num">{r.id}</b>{r.name && <span className="adm-muted adm-num">{r.name}</span>}
            <span>{r.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ——— Сценарии «Возможностей» (web/src/features.ts): что показывают и какие позы Рины в них играют.

const posesOf = (d: Demo) => [d.start.maid, ...d.steps.map((s) => s.set.maid)].filter((x): x is string => Boolean(x));
const KIND_NAMES: Record<Demo["kind"], string> = { widget: "виджет", panel: "панель дня", chat: "Telegram", search: "поиск", stats: "статистика" };

function Scenes({ onAnim }: { onAnim: (id: string) => void }) {
  return (
    <>
      <div className="adm-fx">
        {SCENES.map((f, i) => {
          const demos = [f.ai, ...(f.manual ? [f.manual] : [])];
          const poses = [...new Set(demos.flatMap(posesOf))];
          return (
            <div key={f.id} className="adm-scene">
              <span className="adm-num adm-muted">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <b>{f.title}</b> <span className="adm-muted adm-small adm-num">{f.id}</span>
                <p className="adm-muted adm-small">{f.text}</p>
                <div className="adm-unused">
                  {demos.map((d, k) => <span key={k} className="adm-chip">{KIND_NAMES[d.kind]} · {secText(demoLength(d))}</span>)}
                  {poses.map((p) => <button key={p} className="adm-chip adm-chip-btn" onClick={() => onAnim(p)} title="Открыть в проигрывателе">{p}</button>)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="adm-muted adm-small adm-note">
        Живые примеры — на странице <a className="adm-link" href="/features" onClick={(e) => { e.preventDefault(); navigate("/features"); }}>«Возможности»</a>.
        Позы — кнопки: открывают анимацию в проигрывателе.
      </p>
    </>
  );
}

// ——— Карта функций: реестр (меню сайта, окна программы, команды бота, белый список) и числа «Использования функций».

type FeaturesReport = { features: { id: string; all: UsageNum }[] };

function FunctionMap() {
  const [r, err] = useAdmin<FeaturesReport>("/api/admin/features");
  const usage = usageIndex(r);
  const m = REGISTRY.map;
  const groups = Object.entries(m.groups);
  return (
    <>
      {!r && (err ? <p className="adm-err">Числа «Использования функций» не загрузились: {err}. Карта — без них.</p> : <Loading />)}
      <div className="adm-fmap">
        <MapGroup title="Меню сайта" src="web/src/nav.ts" usage={usage}
          rows={m.site.map((x) => ({ key: x.id, name: x.title, sub: x.path, feature: x.feature }))} />
        <MapGroup title="Окна программы на ПК" src="desktop/src/main.js" usage={usage}
          rows={m.windows.map((x) => ({ key: x.file, name: x.title, sub: x.file, text: x.text, feature: x.feature }))} />
        <MapGroup title="Команды бота" src="server/src/bot.ts" usage={usage}
          rows={m.bot.map((x) => ({ key: x.cmd, name: `/${x.cmd}`, sub: x.owner ? "владелец" : "", text: x.title === `/${x.cmd}` ? "" : x.title, feature: x.feature }))} />
      </div>
      <h2 className="adm-h2">Белый список фич <span className="adm-muted">· {m.features.length} · server/src/feature-list.ts</span></h2>
      <div className="adm-fmap">
        {groups.map(([g, title]) => (
          <MapGroup key={g} title={title} src={g} usage={usage}
            rows={m.features.filter((f) => f.group === g).map((f) => ({ key: f.id, name: f.title, sub: f.by === "server" ? `${f.id} · сервер` : f.id, feature: f.id }))} />
        ))}
      </div>
      <p className="adm-muted adm-small adm-note">
        Карта собрана скриптом из исходников (tools/registry/make_registry.ts), числа — «Использование функций» за 30 дней: раз · людей.
        «—» — у пункта нет своего счётчика.
      </p>
    </>
  );
}

type MapRow = { key: string; name: string; sub?: string; text?: string; feature?: string };

function MapGroup({ title, src, rows, usage }: { title: string; src: string; rows: MapRow[]; usage: (id: string | undefined) => UsageNum | null }) {
  const c = usedCount(rows.map((x) => x.feature), usage);
  const known = rows.length > 0 && usage(rows.find((x) => x.feature)?.feature) !== null;
  return (
    <section className="adm-panel adm-fgroup">
      <h3>{title} <span className="adm-muted adm-num">{rows.length}</span>
        {known && <span className="adm-muted adm-small"> · использовались {c.used} из {c.counted}</span>}
      </h3>
      <span className="adm-muted adm-small adm-num">{src}</span>
      <ul>
        {rows.map((x) => {
          const u = usage(x.feature);
          return (
            <li key={x.key} className={u && !u.uses30 && !u.missing ? "dead" : ""}>
              <div>
                <b>{x.name}</b>{x.sub && <span className="adm-muted adm-small adm-num"> {x.sub}</span>}
                {x.text && <div className="adm-muted adm-small">{x.text}</div>}
              </div>
              <span className="adm-num adm-small" title={x.feature ?? "нет счётчика"}>
                {!x.feature ? "—" : u?.missing ? <span className="adm-muted">нет на сервере</span> : u ? `${u.uses30} · ${u.people30}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
