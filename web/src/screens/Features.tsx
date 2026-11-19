import { useEffect, useRef, useState } from "react";
import { DayPie } from "../charts";
import { demoLength, FEATURES, frameAt, type Demo, type Feature, type Frame, type Row } from "../features";
import { dur } from "../format";
import { navigate } from "../router";

// Раздел «Возможности»: фичи сверху вниз. У каждой — название, зачем она, живой пример «с горничной» (копия виджета) и, где есть,
// второй (копия панели дня, чат Telegram, поиск, круг статистики) и кнопка «▶ Показать».
// Сценарии примеров — features.ts.

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Часы примера: null — стоит на итоге; «Показать» — с нуля до конца. Первый раз запускается сам, когда карточку видно. */
function usePlay(length: number, box: React.RefObject<HTMLElement | null>) {
  const [t, setT] = useState<number | null>(null);
  const run = useRef(0);
  const play = () => {
    if (still()) return setT(null);
    const id = ++run.current;
    const t0 = performance.now();
    const tick = () => {
      if (id !== run.current) return;
      const now = performance.now() - t0;
      if (now >= length) return setT(null);
      setT(now);
      requestAnimationFrame(tick);
    };
    tick();
  };
  useEffect(() => {
    const el = box.current;
    if (!el || still()) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); play(); } }, { threshold: 0.5 });
    io.observe(el);
    return () => { io.disconnect(); run.current++; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { t, play, playing: t !== null };
}

/** Текст печатается по букве: сколько мс прошло с его появления → сколько букв видно. */
const typed = (s: string | undefined, age: number | undefined, msPerChar: number) => (s ?? "").slice(0, Math.floor((age ?? 1e9) / msPerChar));

function RowLine({ r }: { r: Row }) {
  const mark = r.habit ? "fx-habit" : r.task ? "fx-check" : "fx-dot";
  return (
    <li className={[r.fresh && "fresh", r.done && "done", r.late && "late", r.habit && "habit"].filter(Boolean).join(" ")}>
      <i className={`${mark}${r.done ? " on" : ""}`} />
      {r.time && <em>{r.time}</em>}<span>{r.title}</span>{r.note && <small>{r.note}</small>}
    </li>
  );
}

function WidgetDemo({ f, age }: { f: Frame; age: ReturnType<typeof frameAt>["age"] }) {
  const bubble = f.bubble === "…" ? "…" : typed(f.bubble, age.bubble, 22);
  return (
    <div className="fx-stage">
      <div className="fx-top">
        {f.bubble && (
          <div className="fx-bubble" key={f.bubble}>
            <p>{bubble}</p>
            {f.buttons && (
              <div className="fx-buttons">
                {f.buttons.map((b, i) => (
                  <span key={b} className={`${f.fill === i ? "fill" : ""}${f.pressed === i ? " pressed" : ""}`}
                    style={f.fill === i ? { ["--fill" as string]: `${Math.min(100, ((age.fill ?? 0) / 4000) * 100)}%` } : undefined}>{b}</span>
                ))}
              </div>
            )}
          </div>
        )}
        <img className="fx-maid" src={`/maid/${f.maid}.webp`} alt="" />
      </div>
      <div className="fx-panel">
        <div className="fx-clock"><b>12:40</b><span>16 ноября, пн</span></div>
        <ul className="fx-rows">
          {(f.rows ?? []).map((r) => <RowLine key={r.title} r={r} />)}
        </ul>
        <div className={`fx-input${f.mic ? " rec" : ""}`}>
          {f.mic ? <span className="fx-wave">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ animationDelay: `${(i % 5) * 90}ms` }} />)}</span>
            : f.input ? <span className="fx-typed">{typed(f.input, age.input, 55)}<b className="fx-caret" /></span>
            : <span className="fx-ph">Скажи горничной…</span>}
          <span className="fx-mic" />
        </div>
      </div>
    </div>
  );
}

function PanelDemo({ f, age }: { f: Frame; age: ReturnType<typeof frameAt>["age"] }) {
  const flying = f.drag ? Math.min(1, (age.drag ?? 0) / 900) : 0;
  return (
    <div className="fx-stage">
      <div className="fx-day">
        <div className="fx-days">
          {(f.days ?? []).map((d, i) => (
            <span key={d.d} className={`${f.day === i ? "on" : ""}${f.drag?.to === i && flying > 0.6 ? " drop" : ""}`}>
              <b>{d.d}</b><small>{d.wd}</small><small>{d.n ? `(${d.n})` : "–"}</small>
            </span>
          ))}
        </div>
        <ul className="fx-cards">
          {(f.cards ?? []).map((c, i) => (
            <li key={c.title} className={`${c.fresh ? "fresh" : ""}${f.drag?.card === i ? " drag" : ""}`}
              style={f.drag?.card === i ? { transform: `translate(${flying * 70}%, ${-flying * 150}%) rotate(${flying * -4}deg)`, opacity: 1 - flying * 0.4 } : undefined}>
              {c.time && <em>{c.time}</em>}<span>{c.title}</span><i />
            </li>
          ))}
          {!f.cards?.length && <li className="empty">Планов нет</li>}
        </ul>
        {f.form && (
          <div className="fx-form">
            <span>{(f.form.title ? f.form.time : typed(f.form.time, age.form, 90)) || "--:--"}</span>
            <span>{f.form.title ? typed(f.form.title, age.form, 90) : "Название…"}</span>
          </div>
        )}
        <div className={`fx-plus${f.plus ? " on" : ""}`}>+</div>
      </div>
    </div>
  );
}

function ChatDemo({ f }: { f: Frame }) {
  const msgs = f.msgs ?? [];
  return (
    <div className="fx-stage fx-tg">
      <div className="fx-tg-head"><img src="/maid/idle.webp" alt="" /><b>Горничная</b><small>бот</small></div>
      <div className="fx-tg-msgs">
        {msgs.map((m, i) => (
          <div key={`${i}${m.text}`} className={`fx-msg${m.me ? " me" : ""}`}>
            <p>{m.text}<small>{m.time}</small></p>
            {m.buttons && (
              <div className="fx-tg-buttons">
                {m.buttons.map((b, j) => <span key={b} className={i === msgs.length - 1 && f.pressed === j ? "pressed" : ""}>{b}</span>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Слово запроса в найденном — подсвечено (без учёта регистра). */
function highlight(s: string, q: string) {
  const i = q ? s.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? s : <>{s.slice(0, i)}<mark>{s.slice(i, i + q.length)}</mark>{s.slice(i + q.length)}</>;
}

function SearchDemo({ f, age }: { f: Frame; age: ReturnType<typeof frameAt>["age"] }) {
  const q = typed(f.query, age.query, 140);
  return (
    <div className="fx-stage">
      <div className="fx-day">
        <div className="fx-search">⌕ <span>{q || <span className="fx-ph">Поиск по задачам и планам</span>}<b className="fx-caret" /></span><kbd>Ctrl K</kbd></div>
        <ul className="fx-hits">
          {(f.hits ?? []).map((h) => <li key={h.title} className="fresh"><b>{highlight(h.title, f.query ?? "")}</b><small>{h.sub}</small></li>)}
        </ul>
      </div>
    </div>
  );
}

function StatsDemo({ f, age }: { f: Frame; age: ReturnType<typeof frameAt>["age"] }) {
  // Числа нарастают за 1,2 с после шага — как будто день набирается.
  const k = Math.min(1, (age.pc ?? 1e9) / 1200);
  const apps = f.apps ?? [];
  const top = Math.max(1, ...apps.map((a) => a.sec));
  return (
    <div className="fx-stage">
      <div className="fx-day fx-stats">
        <div className="pc-summary">
          <DayPie pc={(f.pc ?? 0) * k} games={(f.games ?? 0) * k} format={dur} size={96} />
          <ul className="pc-legend">
            <li><b>{dur(Math.round((f.pc ?? 0) * k))}</b> за ПК</li>
            <li><b>{dur(Math.round((f.games ?? 0) * k))}</b> в играх</li>
          </ul>
        </div>
        <ul className="fx-apps">
          {apps.map((a) => (
            <li key={a.label}><span>{a.label}</span><i style={{ width: `${(a.sec / top) * 100 * k}%` }} className={a.game ? "game" : ""} /><small>{dur(Math.round(a.sec * k))}</small></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Demo({ d, t }: { d: Demo; t: number | null }) {
  const { frame, age } = frameAt(d, t ?? demoLength(d));
  switch (d.kind) {
    case "widget": return <WidgetDemo f={frame} age={age} />;
    case "panel": return <PanelDemo f={frame} age={age} />;
    case "chat": return <ChatDemo f={frame} />;
    case "search": return <SearchDemo f={frame} age={age} />;
    case "stats": return <StatsDemo f={frame} age={age} />;
  }
}

function FeatureCard({ f }: { f: Feature }) {
  const box = useRef<HTMLElement>(null);
  const length = Math.max(demoLength(f.ai), f.manual ? demoLength(f.manual) : 0);
  const { t, play, playing } = usePlay(length, box);
  return (
    <section className="fx-card reveal" ref={box} id={`f-${f.id}`}>
      <header className="fx-head">
        <div>
          <h3>{f.title}</h3>
          <p>{f.text}</p>
        </div>
        <button className="fx-play" onClick={play} disabled={playing}>{playing ? "Идёт…" : "▶ Показать"}</button>
      </header>
      <div className={`fx-demos${f.manual ? " two" : ""}`}>
        <figure>
          <figcaption>{f.aiTitle ?? (f.manual ? "С горничной" : "Как это выглядит")}</figcaption>
          <Demo d={f.ai} t={t} />
        </figure>
        {f.manual && (
          <figure>
            <figcaption>{f.manualTitle ?? "Вручную"} <span>{f.manualText}</span></figcaption>
            <Demo d={f.manual} t={t} />
          </figure>
        )}
      </div>
    </section>
  );
}

export function Features() {
  return (
    <div className="screen fx">
      <h2 className="screen-title">Возможности</h2>
      <p className="muted fx-lead">Что умеет горничная — с живыми примерами. «Показать» проигрывает пример ещё раз.</p>
      {FEATURES.map((f) => <FeatureCard key={f.id} f={f} />)}
      {/* Каталог для разработки — не в меню (19.11.2026), только отсюда и по адресу /catalog. */}
      <p className="muted small fx-catalog">Как всё устроено внутри — <a href="/catalog" onClick={(e) => { e.preventDefault(); navigate("/catalog"); }}>каталог для разработки</a>.</p>
    </div>
  );
}
