import { useEffect, useRef, useState } from "react";
import { prefill } from "../Composer";
import { demoLength, FEATURES, frameAt, type Demo, type Feature, type Frame } from "../features";

// Раздел «Возможности»: фичи сверху вниз. У каждой — название, зачем она, живой пример «с горничной» (копия виджета) и, где есть,
// «вручную» (копия панели дня), кнопка «▶ Показать» и «Попробовать в чате» (подставляет образец в строку ввода — отправляет человек).
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
          {(f.rows ?? []).map((r) => (
            <li key={r.title} className={r.fresh ? "fresh" : ""}>
              {r.task ? <i className="fx-check" /> : <i className="fx-dot" />}
              {r.time && <em>{r.time}</em>}<span>{r.title}</span>
            </li>
          ))}
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

function Demo({ d, t }: { d: Demo; t: number | null }) {
  const { frame, age } = frameAt(d, t ?? demoLength(d));
  return d.kind === "widget" ? <WidgetDemo f={frame} age={age} /> : <PanelDemo f={frame} age={age} />;
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
          <figcaption>{f.manual ? "С горничной" : "Как это выглядит"}</figcaption>
          <Demo d={f.ai} t={t} />
        </figure>
        {f.manual && (
          <figure>
            <figcaption>Вручную <span>{f.manualText}</span></figcaption>
            <Demo d={f.manual} t={t} />
          </figure>
        )}
      </div>
      {f.sample && (
        <button className="fx-try" onClick={() => prefill(f.sample!)}>Попробовать в чате: «{f.sample}»</button>
      )}
    </section>
  );
}

export function Features() {
  return (
    <div className="screen fx">
      <h2 className="screen-title">Возможности</h2>
      <p className="muted fx-lead">Что умеет горничная — с живыми примерами. «Показать» проигрывает пример ещё раз; «Попробовать» подставит образец в строку внизу, отправите сами.</p>
      {FEATURES.map((f) => <FeatureCard key={f.id} f={f} />)}
    </div>
  );
}
