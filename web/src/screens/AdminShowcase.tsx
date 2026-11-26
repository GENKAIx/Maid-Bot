import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, post } from "../api";
import { FEATURES as SCENES } from "../features";
import { REGISTRY } from "../registry.gen";
import { recolorIsOwn, recolorPixels, SHOW_EYES, SHOW_HAIR, type RecolorOption } from "../recolor";
import {
  bigViewKey, filterCards, frameStart, liveSet, runPlay, runRemain, runSpeed, runStarted, type ShowRun, PLAYER_SPEEDS, playerStep, cropOf, PREVIEW_CROPS, PREVIEW_H, PREVIEW_SLOW, PREVIEW_URL, PREVIEW_W, previewScale, secText, SHOW_FILTERS,
  SHOW_GROUPS, showcaseCards, sizeText, usageIndex, usedCount, animWhen, posterOf, preloadAll, preloadText, PREVIEW_FILES_URL,
  type AnimInfo, type PreloadState, type PreviewFile, type PreviewPlay, type ShowCard, type ShowFilter, type UsageNum,
} from "../showcase";
import { navigate } from "../router";
import { AdminLost, Loading, useAdmin } from "./AdminSections";

// «Витрина» админки (этап 4, 24.11.2026; живой показ — 25.11.2026) — свой кусок (lazy в Admin.tsx). Карточки по группам:
// 41 анимация Рины, слова с характером, облачко, походка букв, погода, праздники привычек и 12 сценариев «Возможностей» —
// в каждой настоящий виджет программы на ПК (desktop/renderer в iframe, server/src/preview.ts) с заглушкой window.maid
// и тестовыми данными: нажал — проигрывается, «ещё раз», «медленно», настроение реплики. Виджет запускается, только когда
// по «играть» (не больше PREVIEW_LIVE_MAX сразу; остальные карточки — неподвижный первый кадр), играет одна карточка. Файлы
// показа — с меткой версии, из кэша браузера; «Загрузить всё заранее» скачивает их разом (26.11.2026). Щелчок по названию — большой просмотр
// (← → — соседние карточки, Esc — закрыть), у анимаций там же покадровый проигрыватель картинок сайта с перекраской.
// Карточки — из реестра web/src/registry.gen.ts (tools/registry/make_registry.ts) и features.ts (showcase.ts showcaseCards).

type Tab = "live" | "map";
const CARDS = showcaseCards(REGISTRY, SCENES);
const TABS: { id: Tab; title: string }[] = [
  { id: "live", title: `Живой показ ${CARDS.length}` },
  { id: "map", title: "Карта функций" },
];

export function AdminShowcase() {
  const [tab, setTab] = useState<Tab>("live");
  return (
    <>
      <div className="adm-toolbar">
        <div className="adm-seg-ctl" role="tablist" aria-label="Витрина">
          {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>{t.title}</button>)}
        </div>
      </div>
      {tab === "live" ? <LiveShow /> : <FunctionMap />}
    </>
  );
}

// ——— Живой показ.

/** Пропуск к файлам виджета (POST /api/admin/preview → cookie): "" — ещё нет, "ok", иначе текст ошибки. */
function usePreviewPass(): string {
  const [state, setState] = useState("");
  const lost = useContext(AdminLost);
  useEffect(() => {
    let alive = true;
    post<{ until: string }>("/api/admin/preview").then(() => alive && setState("ok")).catch((e) => {
      if (!alive) return;
      if (e instanceof ApiError && e.status === 403) lost();
      else setState((e as Error).message || "не получилось");
    });
    return () => { alive = false; };
  }, [lost]);
  return state;
}

/** Файлы показа с метками (GET /admin-preview/files.json по пропуску): null — ещё нет, [] — не получилось. */
function usePreviewFiles(pass: string): PreviewFile[] | null {
  const [files, setFiles] = useState<PreviewFile[] | null>(null);
  useEffect(() => {
    if (pass !== "ok") return;
    let alive = true;
    fetch(PREVIEW_FILES_URL, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((x: { files?: PreviewFile[] }) => alive && setFiles(Array.isArray(x.files) ? x.files : []))
      .catch(() => alive && setFiles([]));
    return () => { alive = false; };
  }, [pass]);
  return files;
}

export function LiveShow({ cards = CARDS, pass: given, files: givenFiles }: { cards?: ShowCard[]; pass?: string; files?: PreviewFile[] }) {
  const got = usePreviewPass();
  const pass = given ?? got;
  const gotFiles = usePreviewFiles(givenFiles ? "" : pass);
  const files = givenFiles ?? gotFiles;
  // Картинка карточки анимации: первый кадр с меткой; нет пропуска или списка — анимация сайта; пропуск или список ещё ждём — пусто.
  const posterFor = (c: ShowCard) => (!c.poster ? undefined : files?.length ? posterOf(files, c.id) ?? c.poster : (pass && pass !== "ok") || files ? c.poster : null);
  const [filter, setFilter] = useState<ShowFilter>("all");
  const [q, setQ] = useState("");
  const [sound, setSound] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [visible, setVisible] = useState<string[]>([]);
  const [onScreen, setOnScreen] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [big, setBig] = useState<string | null>(null);
  const shown = useMemo(() => filterCards(cards, filter, q), [cards, filter, q]);
  const live = pass === "ok" ? liveSet(visible, recent, playing, undefined, onScreen) : [];
  const timer = useRef(0);
  // Идущий показ: сколько его своего времени уже прошло (done) и с какой скоростью идёт сейчас (k) — «медленно» тянет конец.
  // Отсчёт конца — с той минуты, когда виджет готов и команда play ушла (onStarted), а не с нажатия: первый запуск грузит виджет.
  const run = useRef<ShowRun | null>(null);

  const toggle = (on: boolean, key: string) => (v: string[]) => (on ? (v.includes(key) ? v : [...v, key]) : v.filter((k) => k !== key));
  const onVisible = useCallback((key: string, on: boolean, screen: boolean) => (screen ? setOnScreen : setVisible)(toggle(on, key)), []);
  const arm = useCallback(() => {
    const r = run.current;
    const left = runRemain(r);
    clearTimeout(timer.current);
    if (r && left !== null) timer.current = window.setTimeout(() => setPlaying((p) => (p === r.key ? null : p)), left);
  }, []);
  // Нажали «играть»: эта карточка — играющая (прежняя остановится), её виджет — живой в первую очередь; по окончании — снова тихо.
  const onPlay = useCallback((c: ShowCard, k: number) => {
    setPlaying(c.key);
    setRecent((r) => [c.key, ...r.filter((x) => x !== c.key)].slice(0, 12));
    run.current = runPlay(c.key, c.ms, k);
    arm();
  }, [arm]);
  // Виджет карточки принял play (после ready) — показ пошёл, ставим его конец.
  const onStarted = useCallback((c: ShowCard) => {
    run.current = runStarted(run.current, c.key, performance.now());
    arm();
  }, [arm]);
  // «Медленно» переключили посреди показа — конец переставляется под новую скорость.
  const onSpeed = useCallback((c: ShowCard, k: number) => {
    const r = run.current;
    if (!r || r.key !== c.key) return;
    run.current = runSpeed(r, c.key, k, performance.now());
    arm();
  }, [arm]);
  // Поза из сценария — карточка этой анимации в большом просмотре (её не видно за фильтром или поиском — они сбрасываются).
  const openKey = (key: string) => {
    setPlaying(null);
    if (!shown.some((c) => c.key === key)) { setFilter("all"); setQ(""); }
    setBig(key);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const counts = (f: ShowFilter) => filterCards(cards, f, "").length;
  const bigList = big && !shown.some((c) => c.key === big) ? cards : shown;
  const bigIdx = big ? bigList.findIndex((c) => c.key === big) : -1;

  return (
    <>
      <div className="adm-toolbar adm-live-tools">
        <input className="adm-live-q" type="search" placeholder="Поиск: название, id, описание" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск по витрине" />
        <div className="adm-seg-ctl adm-live-filter" role="tablist" aria-label="Группа">
          {SHOW_FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? "on" : ""} onClick={() => setFilter(f.id)}>
              {f.title} <span className="adm-muted">{counts(f.id)}</span>
            </button>
          ))}
        </div>
        <button className={`adm-btn small ${sound ? "on" : ""}`} aria-pressed={sound} onClick={() => setSound(!sound)} title="Звуки виджета: «бип» печати, звуки эмоций и облачка">
          {sound ? "🔊 звук" : "🔇 без звука"}
        </button>
        {pass === "ok" && files && files.length > 0 && <Preload files={files} />}
      </div>
      <p className="adm-muted adm-small adm-note adm-live-why">
        В карточках — настоящий виджет программы на ПК (файлы <code>desktop/renderer</code>) с тестовыми данными: ничего не записывается и никуда не уходит.
        Виджет запускается кнопкой «играть» (до того — неподвижный первый кадр); играет одна. «Медленно» — вчетверо: буквы, облачко, эффекты и кадры фигурки.
      </p>
      {pass && pass !== "ok" && <p className="adm-err" role="alert">Живой показ недоступен: {pass}. Карточки — с картинками.</p>}
      {!shown.length && <p className="adm-muted">Ничего не нашлось.</p>}
      {SHOW_GROUPS.map((g) => {
        const list = shown.filter((c) => c.group === g.id);
        if (!list.length) return null;
        return (
          <section key={g.id} className="adm-live-group" aria-label={g.title}>
            <h2 className="adm-h2">{g.title} <span className="adm-muted">· {list.length} · {g.src}</span>
              {g.id === "scene" && <> · <a className="adm-link" href="/features" onClick={(e) => { e.preventDefault(); navigate("/features"); }}>страница «Возможности»</a></>}
            </h2>
            <div className="adm-live-grid">
              {list.map((c) => (
                <LiveCard key={c.key} card={c} poster={posterFor(c)} live={live.includes(c.key)} active={playing === c.key && !big} sound={sound}
                  onVisible={onVisible} onPlay={onPlay} onStarted={onStarted} onSpeed={onSpeed} onBig={() => { setPlaying(null); setBig(c.key); }} onPose={(id) => openKey(`anim:${id}`)} />
              ))}
            </div>
          </section>
        );
      })}
      {big && bigIdx >= 0 && (
        <BigView card={bigList[bigIdx]} poster={posterFor(bigList[bigIdx])} live={pass === "ok"} sound={sound} n={bigIdx + 1} total={bigList.length}
          onClose={() => setBig(null)} onStep={(d) => setBig(bigList[(bigIdx + d + bigList.length) % bigList.length].key)} />
      )}
    </>
  );
}

/** «Загрузить всё заранее»: все файлы показа с меткой — в кэш браузера, по PRELOAD_PARALLEL сразу, с полоской и отменой. */
function Preload({ files }: { files: PreviewFile[] }) {
  const [st, setSt] = useState<PreloadState | null>(null);
  const [run, setRun] = useState(false);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);
  const start = async () => {
    const ctl = new AbortController();
    stop.current = ctl;
    setRun(true);
    setSt(null);
    const get = async (url: string, signal?: AbortSignal) => {
      const r = await fetch(url, { signal, credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await r.arrayBuffer(); // до конца — иначе браузер не положит файл в кэш
    };
    const end = await preloadAll(files, get, { signal: ctl.signal, onProgress: (x) => { if (stop.current === ctl) setSt(x); } });
    if (stop.current === ctl) { setSt(end); setRun(false); stop.current = null; }
  };
  const cancel = () => {
    stop.current?.abort();
    stop.current = null;
    setRun(false);
    setSt((x) => (x ? { ...x, stopped: true } : x));
  };
  const total = files.reduce((a, f) => a + f.bytes, 0);
  return (
    <div className="adm-row adm-live-preload" aria-live="polite">
      {run ? (
        <>
          <progress max={files.length} value={st ? st.done + st.failed : 0} aria-label="Загрузка файлов показа" />
          <span className="adm-num adm-small">{st ? preloadText(st) : `0 из ${files.length}`}</span>
          <button className="adm-btn small" onClick={cancel}>Отмена</button>
        </>
      ) : (
        <>
          <button className="adm-btn small" onClick={() => void start()} title={`Все файлы показа (${files.length}, ${sizeText(total)}) — в кэш браузера: потом карточки не ждут загрузки`}>
            ⬇ Загрузить всё заранее
          </button>
          {st && !st.stopped && !st.failed && <span className="adm-muted adm-small">всё в кэше браузера ({sizeText(st.bytes)})</span>}
          {st && !st.stopped && st.failed > 0 && <span className="adm-err adm-small">не скачалось {st.failed} из {st.total}</span>}
          {st?.stopped && <span className="adm-muted adm-small">остановлено: {preloadText(st)}</span>}
        </>
      )}
    </div>
  );
}

/** Карточка: виджет (или картинка, пока он не запущен), название, описание и кнопки. */
function LiveCard({ card, poster, live, active, sound, onVisible, onPlay, onStarted, onSpeed, onBig, onPose }: {
  card: ShowCard; poster?: string | null; live: boolean; active: boolean; sound: boolean;
  onVisible: (key: string, on: boolean, screen: boolean) => void; onPlay: (c: ShowCard, k: number) => void; onStarted: (c: ShowCard) => void;
  onSpeed: (c: ShowCard, k: number) => void;
  onBig: () => void; onPose: (id: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [slow, setSlow] = useState(false);
  const [mood, setMood] = useState(card.moods?.[0]?.id ?? "");
  const [order, setOrder] = useState<{ n: number; play: PreviewPlay } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // Два наблюдателя: с запасом 200 px — виджет можно запускать заранее; без запаса — карточка на самом экране (живые — сначала они).
    const near = new IntersectionObserver(([e]) => onVisible(card.key, e.isIntersecting, false), { rootMargin: "200px 0px" });
    const screen = new IntersectionObserver(([e]) => onVisible(card.key, e.isIntersecting, true));
    near.observe(el);
    screen.observe(el);
    return () => { near.disconnect(); screen.disconnect(); onVisible(card.key, false, false); onVisible(card.key, false, true); };
  }, [card.key, onVisible]);
  const go = (m = mood) => { setOrder((o) => ({ n: (o?.n ?? 0) + 1, play: card.play(m || undefined) })); onPlay(card, slow ? PREVIEW_SLOW : 1); };
  return (
    <article ref={ref} className={`adm-live-card ${active ? "on" : ""}`}>
      <PreviewBox card={card} poster={poster} live={live} order={active ? order : null} active={active} slow={slow} sound={sound} onStarted={() => onStarted(card)} />
      <div className="adm-live-meta">
        <button className="adm-live-title" onClick={onBig} title="Большой просмотр">
          <b>{card.title}</b> <span className="adm-muted adm-num">{card.sub}</span>
        </button>
        <p className="adm-muted adm-small">{card.text}</p>
        <SceneMore card={card} onPose={onPose} />
      </div>
      <Controls card={card} active={active} slow={slow} mood={mood} onPlay={() => go()}
        onSlow={() => { setSlow(!slow); if (active) onSpeed(card, slow ? 1 : PREVIEW_SLOW); }}
        onMood={(m) => { setMood(m); go(m); }} onBig={onBig} />
    </article>
  );
}

/** У сценария: второй пример (он — на странице «Возможности») и позы горничной — ссылки на карточки анимаций. */
function SceneMore({ card, onPose }: { card: ShowCard; onPose: (id: string) => void }) {
  if (!card.extra && !card.poses?.length) return null;
  return (
    <>
      {card.extra && <p className="adm-muted adm-small">{card.extra} — <a className="adm-link" href="/features" onClick={(e) => { e.preventDefault(); navigate("/features"); }}>на странице «Возможности»</a></p>}
      {card.poses && card.poses.length > 0 && (
        <div className="adm-row adm-live-poses" aria-label="Позы горничной">
          {card.poses.map((id) => <button key={id} className="adm-chip" onClick={() => onPose(id)} title="Анимация в большом просмотре">{id}</button>)}
        </div>
      )}
    </>
  );
}

function Controls({ card, active, slow, mood, onPlay, onSlow, onMood, onBig }: {
  card: ShowCard; active: boolean; slow: boolean; mood: string; onPlay: () => void; onSlow: () => void; onMood: (m: string) => void; onBig?: () => void;
}) {
  return (
    <div className="adm-row adm-live-ctl">
      <button className="adm-btn small primary" onClick={onPlay}>{active ? "↻ ещё раз" : "▶ играть"}</button>
      <button className={`adm-btn small ${slow ? "on" : ""}`} aria-pressed={slow} onClick={onSlow} title="Вчетверо медленнее">🐢 медленно</button>
      {card.moods && (
        <select className="adm-live-mood" value={mood} onChange={(e) => onMood(e.target.value)} aria-label={card.group === "holiday" ? "Рубеж серии" : "Настроение реплики"}>
          {card.moods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      )}
      {onBig && <button className="adm-btn small" onClick={onBig} title="Большой просмотр" aria-label="Большой просмотр">⤢</button>}
    </div>
  );
}

/** Окно виджета, уменьшенное под ширину карточки; пока не живой — картинка (poster: первый кадр; null — её ещё ждём) или пример текста. */
function PreviewBox({ card, poster, live, order, active, slow, sound, big, onKey, onStarted }: {
  card: ShowCard; poster?: string | null; live: boolean; order: { n: number; play: PreviewPlay } | null; active: boolean; slow: boolean; sound: boolean; big?: boolean;
  onKey?: (key: string) => void; onStarted?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Карточка — нужная часть окна (PREVIEW_CROPS), большой просмотр — всё окно.
  const crop = big ? { x: 0, y: 0, w: PREVIEW_W, h: PREVIEW_H } : PREVIEW_CROPS[cropOf(card.group)];
  const [scale, setScale] = useState(big ? 1 : 0.5);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setScale(previewScale(e.contentRect.width, e.contentRect.height || Infinity, crop.w, crop.h)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [crop.w, crop.h]);
  return (
    <div ref={box} className={`adm-live-box ${big ? "big" : ""}`} style={big ? undefined : { aspectRatio: `${crop.w} / ${crop.h}` }}>
      {live ? (
        <div className="adm-live-frame" style={{ width: PREVIEW_W, height: PREVIEW_H, transform: `scale(${scale}) translate(${-crop.x}px, ${-crop.y}px)` }}>
          <WidgetFrame title={`Виджет: ${card.title}`} order={order} active={active} slow={slow} sound={sound} interactive={big} onKey={onKey} onStarted={onStarted} />
        </div>
      ) : poster ? (
        <img className="adm-live-poster" src={poster} alt="" width={180} height={192} loading="lazy" decoding="async" />
      ) : card.still && !card.poster ? (
        <Still still={card.still} />
      ) : (
        <span className="adm-live-wait adm-muted adm-small">{card.sub}</span>
      )}
    </div>
  );
}

/** Образец, пока виджет не запущен: облачко с репликой (слово с эффектом выделено) или значок с подписью. */
function Still({ still }: { still: NonNullable<ShowCard["still"]> }) {
  const at = still.word ? still.text.indexOf(still.word) : -1;
  return (
    <span className="adm-live-still">
      {still.icon && <span className="adm-live-still-icon" aria-hidden="true">{still.icon}</span>}
      {at < 0 ? still.text : <>{still.text.slice(0, at)}<mark>{still.word}</mark>{still.text.slice(at + still.word!.length)}</>}
    </span>
  );
}

/** Сам iframe: ждёт «готов» от control.js, потом шлёт скорость, звук и что проиграть; перестал быть играющим — «стоп». */
function WidgetFrame({ title, order, active, slow, sound, interactive, onKey, onStarted }: {
  title: string; order: { n: number; play: PreviewPlay } | null; active: boolean; slow: boolean; sound: boolean; interactive?: boolean;
  onKey?: (key: string) => void; onStarted?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const keyTo = useRef(onKey);
  keyTo.current = onKey;
  const startedTo = useRef(onStarted);
  startedTo.current = onStarted;
  const [ready, setReady] = useState(false);
  const send = useCallback((msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ maidPreview: 1, ...msg }, location.origin), []);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== location.origin || e.data?.maidPreview !== 1) return;
      if (e.data.ev === "ready") setReady(true);
      // Клавиша, нажатая в виджете (фокус в iframe): control.js пересылает Esc, ← и →.
      if (e.data.ev === "key" && typeof e.data.key === "string") keyTo.current?.(e.data.key);
    };
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, []);
  useEffect(() => { if (ready) send({ cmd: "speed", k: slow ? PREVIEW_SLOW : 1 }); }, [ready, slow, send]);
  useEffect(() => { if (ready) send({ cmd: "mute", on: !sound }); }, [ready, sound, send]);
  // play уходит только после ready; ушёл — сообщаем наверх: отсюда считается конец показа.
  useEffect(() => { if (ready && order) { send({ cmd: "play", play: order.play }); startedTo.current?.(); } }, [ready, order, send]);
  const was = useRef(false);
  useEffect(() => {
    if (ready && was.current && !active) send({ cmd: "stop" });
    was.current = active;
  }, [ready, active, send]);
  return <iframe ref={frame} src={PREVIEW_URL} title={title} className={interactive ? "on" : ""} width={PREVIEW_W} height={PREVIEW_H} />;
}

/** Большой просмотр: виджет крупно (можно трогать: тычок, облачко), подробности; у анимаций — покадровый проигрыватель. */
function BigView({ card, poster, live, sound, n, total, onClose, onStep }: {
  card: ShowCard; poster?: string | null; live: boolean; sound: boolean; n: number; total: number; onClose: () => void; onStep: (d: number) => void;
}) {
  const [slow, setSlow] = useState(false);
  const [mood, setMood] = useState(card.moods?.[0]?.id ?? "");
  const [order, setOrder] = useState<{ n: number; play: PreviewPlay } | null>(null);
  const [frames, setFrames] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const go = (m = mood) => setOrder((o) => ({ n: (o?.n ?? 0) + 1, play: card.play(m || undefined) }));
  useEffect(() => { setMood(card.moods?.[0]?.id ?? ""); setFrames(false); setOrder({ n: 1, play: card.play(card.moods?.[0]?.id) }); }, [card]);
  useEffect(() => { dialog.current?.focus(); }, []);
  const act = (k: ReturnType<typeof bigViewKey>) => {
    if (k === "close") onClose();
    else if (k) onStep(k === "prev" ? -1 : 1);
    return Boolean(k);
  };
  const keys = (e: KeyboardEvent) => {
    const field = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (act(bigViewKey(e.key, { field, handled: e.defaultPrevented })) && e.key !== "Escape") e.preventDefault();
  };
  const a = card.anim;
  return (
    <div className="adm-live-shade" onClick={onClose}>
      <div ref={dialog} className="adm-live-big" role="dialog" aria-modal="true" aria-label={card.title} tabIndex={-1} onKeyDown={keys} onClick={(e) => e.stopPropagation()}>
        <div className="adm-live-big-view">
          {frames && a ? <PlayerWithColors anim={a} /> : <PreviewBox card={card} poster={poster} live={live} order={order} active slow={slow} sound={sound} big onKey={(k) => act(bigViewKey(k))} />}
        </div>
        <div className="adm-live-big-side">
          <div className="adm-row adm-live-big-nav">
            <button className="adm-btn small" onClick={() => onStep(-1)} title="Предыдущая (←)" aria-label="Предыдущая">←</button>
            <span className="adm-num adm-muted">{n} / {total}</span>
            <button className="adm-btn small" onClick={() => onStep(1)} title="Следующая (→)" aria-label="Следующая">→</button>
            <span className="adm-grow" />
            <button className="adm-btn small" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
          </div>
          <h2>{card.title} <span className="adm-muted adm-num">{card.sub}</span></h2>
          <p className="adm-muted adm-small">{card.text}</p>
          {a && (
            <dl className="adm-live-dl">
              <dt>Когда играет</dt><dd>{animWhen(a)}</dd>
              <dt>Кадров</dt><dd className="adm-num">{a.desk.frames} в виджете · {a.frames} на сайте</dd>
              <dt>Длительность</dt><dd className="adm-num">{secText(a.ms)}{a.group === "once" ? " · один раз" : " · по кругу"}</dd>
              <dt>Холст</dt><dd className="adm-num">{a.desk.w}×{a.desk.h} в виджете · {a.w}×{a.h} на сайте ({sizeText(a.bytes)})</dd>
            </dl>
          )}
          {!frames && <Controls card={card} active={Boolean(order)} slow={slow} mood={mood} onPlay={() => go()} onSlow={() => setSlow(!slow)} onMood={(m) => { setMood(m); go(m); }} />}
          {a && (
            <button className={`adm-btn small ${frames ? "on" : ""}`} aria-pressed={frames} onClick={() => setFrames(!frames)}>
              {frames ? "← живой виджет" : "Покадрово и перекраска (картинка сайта)"}
            </button>
          )}
          {!live && <p className="adm-muted adm-small">Живой виджет недоступен — только картинка.</p>}
          <p className="adm-muted adm-small">Виджет можно трогать: щелчок по горничной, облачко, строка ввода. ← → — соседние карточки, Esc — закрыть.</p>
        </div>
      </div>
    </div>
  );
}

// ——— Покадровый проигрыватель картинок сайта (большой просмотр анимации): шаги, скорость, перекраска.

function PlayerWithColors({ anim }: { anim: AnimInfo }) {
  const [hair, setHair] = useState("red");
  const [eyes, setEyes] = useState("violet");
  return (
    <div className="adm-live-player">
      <Player key={anim.id} anim={anim} hair={hair} eyes={eyes} />
      <Swatches title="Волосы" table={SHOW_HAIR} value={hair} onChange={setHair} />
      <Swatches title="Глаза" table={SHOW_EYES} value={eyes} onChange={setEyes} />
    </div>
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
    // Свои клавиши — дальше не идут: стрелки шагают по кадрам, а не листают карточки большого просмотра.
    if (e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); setPlaying(false); seek(idx + (e.key === "ArrowLeft" ? -1 : 1)); }
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
