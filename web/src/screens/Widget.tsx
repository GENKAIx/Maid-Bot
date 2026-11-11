import { type ReactNode, useEffect, useRef, useState } from "react";
import { Card, Empty, Spinner } from "../components";

// Виджет на рабочем столе: что на панели, горничная, задачи, сроки самонажатия кнопок. Настройки живут в программе на ПК
// (desktop/src/preload-app.js → main.js «app:widget-*»), сайт их только показывает и меняет; в браузере и на телефоне раздела нет.

export interface WidgetPrefs {
  show?: boolean; opacity?: number; side?: "left" | "right" | "none"; size?: "s" | "m" | "l";
  sections?: { next?: boolean; habits?: boolean; tasks?: boolean; soon?: boolean };
  plans?: "list" | "off"; dateLead?: "0" | "1" | "3" | "7"; doneTasks?: "keep" | "hide"; laterTasks?: "hide" | "show";
  proposalWait?: number; clashWait?: number; mute?: boolean; typing?: "sound" | "quiet" | "off"; typeSpeed?: "slow" | "normal" | "fast";
  accent?: Accent; textSize?: "s" | "m" | "l"; taskCount?: 4 | 6 | 10; nextCount?: 1 | 3 | 5; doneHabits?: "dim" | "hide";
}
type Accent = "violet" | "blue" | "green" | "pink" | "amber";
interface Bridge {
  widget(): Promise<WidgetPrefs | null>;
  saveWidget(patch: WidgetPrefs): Promise<WidgetPrefs | null>;
  resetWidget(): Promise<void>;
}
declare global {
  interface Window { maidDesktop?: Bridge }
}
export const desktop = () => window.maidDesktop;

// Те же значения по умолчанию, что у виджета (desktop/renderer/widget.js, cfg).
const DEFAULTS: Required<WidgetPrefs> = {
  show: true, opacity: 0.92, side: "right", size: "m", sections: { next: true, habits: true, tasks: true, soon: true },
  plans: "list", dateLead: "1", doneTasks: "keep", laterTasks: "hide", proposalWait: 12, clashWait: 10, mute: false, typing: "sound", typeSpeed: "normal",
  accent: "violet", textSize: "m", taskCount: 6, nextCount: 3, doneHabits: "dim",
};
const ACCENTS: [Accent, string][] = [["violet", "Сиреневый"], ["blue", "Голубой"], ["green", "Мятный"], ["pink", "Розовый"], ["amber", "Янтарный"]];
const SECTIONS: [keyof NonNullable<WidgetPrefs["sections"]>, string][] = [["next", "Ближайший план"], ["habits", "Привычки"], ["tasks", "Задачи"], ["soon", "Скоро"]];

function Segment<T extends string | number>({ value, options, onPick, label }: { value: T; options: [T, string][]; onPick: (v: T) => void; label: string }) {
  return (
    <div className="segment" role="radiogroup" aria-label={label}>
      {options.map(([v, name]) => (
        <button key={String(v)} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onPick(v)}>{name}</button>
      ))}
    </div>
  );
}

/** Выбор карточками: у каждого варианта — маленькая копия того, как это выглядит в виджете. */
function Cards<T extends string | number>({ value, options, onPick, label }: { value: T; options: [T, string, ReactNode][]; onPick: (v: T) => void; label: string }) {
  return (
    <div className={`done-modes cols-${options.length}`} role="radiogroup" aria-label={label}>
      {options.map(([v, name, pic]) => (
        <button key={String(v)} role="radio" aria-checked={value === v} className={`dm${value === v ? " on" : ""}`} onClick={() => onPick(v)}>
          <div className="dm-mini">{pic}</div>
          <span>{name}</span>
        </button>
      ))}
    </div>
  );
}
const Row = ({ t, did }: { t: string; did?: boolean }) => (did ? <p className="did"><i>✓</i><s>{t}</s></p> : <p><i></i>{t}</p>);
const TASKS = ["Купить хлеб", "Позвонить маме", "Оплатить свет", "Полить цветы", "Разобрать почту", "Записаться к врачу", "Купить лампочку", "Вынести мусор", "Почистить кофеварку", "Ответить Лёше"];
const PLANS: [string, string][] = [["10:00", "Врач"], ["14:30", "Созвон"], ["Завтра", "Спорт"], ["Сб", "Дача"], ["Вс", "Кино"]];

/** Горничная над панелью: где стоит и какого размера. */
function Perch({ side, size = "m", plans }: { side: "left" | "right" | "none"; size?: "s" | "m" | "l"; plans?: boolean }) {
  return (
    <div className={`wm-stage side-${side}`}>
      {plans && <div className="wm-plans"><p><em>10:00</em> Врач</p><p><em>14:30</em> Созвон</p></div>}
      {side !== "none" && <img className={`wm-maid size-${size}`} src="/maid/idle.webp" alt="" />}
      <div className="wm-panel"><b>12:40</b><p><i></i>Купить хлеб</p></div>
    </div>
  );
}

/** Выбор списком: каждый вариант — своя строка с пояснением. */
function Choices<T extends string>({ value, options, onPick, label }: { value: T; options: [T, string, string][]; onPick: (v: T) => void; label: string }) {
  return (
    <div className="wp-choices" role="radiogroup" aria-label={label}>
      {options.map(([v, name, hint]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onPick(v)}>
          <i /><b>{name}</b><span>{hint}</span>
        </button>
      ))}
    </div>
  );
}

// Как печатает виджет (desktop/renderer/widget.js, planType/runType): знаков в секунду, паузы после знаков, «бип» на каждую третью букву.
const TYPE_CPS = { slow: 22, normal: 35, fast: 60 };
const SAY = "Записала: купить хлеб завтра к 10:00. Не забудь пакет!";
const SAY_AT = (speed: keyof typeof TYPE_CPS) => {
  let t = 0;
  return [...SAY].map((ch) => { const now = t; t += 1000 / TYPE_CPS[speed] + (/[.!?…]/.test(ch) ? 260 : /[,;:]/.test(ch) ? 120 : 0); return now; });
};

let actx: AudioContext | null = null;
/** Тот же «бип», что у виджета при печати (desktop/renderer/widget.js, typeBlip). */
function blip(base: number) {
  try {
    actx ??= new AudioContext();
    const t = actx.currentTime + 0.002;
    const o = actx.createOscillator(), f = actx.createBiquadFilter(), g = actx.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.22), t);
    f.type = "lowpass";
    f.frequency.value = 2200;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.045, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    o.connect(f).connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + 0.07);
  } catch { /* без звука */ }
}

/** Живая копия облачка виджета: пусто → облачко появляется → текст печатается (или сразу целиком) → висит → пропадает, по кругу. */
function SayPreview({ mode, speed, side, mute, ping }: { mode: "sound" | "quiet" | "off"; speed: "slow" | "normal" | "fast"; side: "left" | "right"; mute: boolean; ping: number }) {
  const [t, setT] = useState(0);
  const [hover, setHover] = useState(false);
  const [loudTill, setLoudTill] = useState(0); // после выбора — один показ со звуком
  const lastBeep = useRef(0);
  useEffect(() => {
    const t0 = performance.now();
    const id = setInterval(() => setT(performance.now() - t0), 16);
    return () => clearInterval(id);
  }, [mode, speed, ping]);
  const at = SAY_AT(speed);
  const typed = mode !== "off";
  const GAP = 900, POP = 200;
  const total = typed ? at[at.length - 1] + 60 : 0;
  const cycle = GAP + POP + total + 2600 + 300;
  const c = t % cycle;
  const since = c - GAP - POP; // от конца появления облачка
  const up = c >= GAP && c < cycle - 300;
  const shown = !typed ? SAY.length : since < 0 ? 0 : at.filter((x) => x <= since).length;
  const letters = [...SAY].slice(0, shown).filter((ch) => /\S/.test(ch)).length;
  const beep = mode === "sound" && since >= 0 && shown < SAY.length ? Math.floor((letters + 2) / 3) : -1;
  // Звук — как у виджета (typeBlip): короткий «бип» на каждую третью букву. Слышно при наведении и один круг после выбора.
  useEffect(() => { if (ping) setLoudTill(performance.now() + cycle); }, [ping]); // eslint-disable-line react-hooks/exhaustive-deps
  const loud = !mute && mode === "sound" && (hover || performance.now() < loudTill);
  useEffect(() => {
    if (beep <= 0 || beep === lastBeep.current) { if (beep <= 0) lastBeep.current = 0; return; }
    lastBeep.current = beep;
    if (loud) blip(640);
  }, [beep, loud]);
  return (
    <div className={`wp-say side-${side}`} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <div className="wp-say-hint">{mode !== "sound" ? "" : mute ? "🔇 звуки выключены" : loud ? "🔊 со звуком" : "🔈 наведите — будет слышно"}</div>
      <div className={`wp-say-bubble${up ? " up" : ""}${c >= cycle - 300 ? " out" : ""}`} key={Math.floor(t / cycle)}>
        {[...SAY].map((ch, i) => <span key={i} className={i < shown ? "on" : ""}>{ch}</span>)}
      </div>
      {mode === "sound" && beep > 0 && <div className="wp-say-beep" key={beep}>♪</div>}
      <img className="wp-say-maid" src="/maid/idle.webp" alt="" />
    </div>
  );
}

export function Widget() {
  const bridge = desktop();
  const [p, setP] = useState<Required<WidgetPrefs> | null>(null);
  const [opacity, setOpacity] = useState(DEFAULTS.opacity);
  const [msg, setMsg] = useState("");
  const [ping, setPing] = useState(0); // выбрали что-то про облачко — показать его ещё раз со звуком

  useEffect(() => {
    if (!bridge) return;
    void bridge.widget().then((w) => {
      const all = { ...DEFAULTS, ...w, sections: { ...DEFAULTS.sections, ...w?.sections } };
      setP(all);
      setOpacity(all.opacity);
    });
  }, [bridge]);

  if (!bridge) return <Empty>Виджет — это программа «Горничная» на компьютере. Его настройки — в ней: раздел «Виджет» слева.</Empty>;
  if (!p) return <Spinner />;

  async function save(patch: WidgetPrefs) {
    setP((x) => ({ ...x!, ...patch, sections: { ...x!.sections, ...patch.sections } }));
    const r = await bridge!.saveWidget(patch).catch(() => null);
    if (!r) setMsg("Не сохранилось: перезапустите программу «Горничная».");
  }

  return (
    <div className="screen wp">
      <h2 className="screen-title">Виджет</h2>
      <p className="muted small">Панель с горничной на рабочем столе этого компьютера. Меняется сразу; на других устройствах — свои настройки.</p>
      {msg && <div className="toast" style={{ marginTop: 12 }}><div className="toast-text">{msg}</div><button className="ghost" onClick={() => setMsg("")}>✕</button></div>}
      <div className="cards">
        <Card title="Окно" className="reveal">
          <div className="form">
            <label className="row"><input type="checkbox" checked={p.show} onChange={(e) => save({ show: e.target.checked })} /> Виджет поверх всех окон</label>
            <label>Непрозрачность панели · {Math.round(opacity * 100)}%
              <input type="range" min={0.4} max={1} step={0.02} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))}
                onPointerUp={() => save({ opacity })} onKeyUp={() => save({ opacity })} />
            </label>
            <div className="row"><button onClick={() => { void bridge.resetWidget(); setMsg("Виджет вернулся в правый нижний угол."); }}>Вернуть в угол</button></div>
          </div>
        </Card>

        <Card title="Горничная" className="reveal">
          <div className="form">
            <label>Где стоит</label>
            <Cards label="Где стоит" value={p.side} onPick={(side) => save({ side })}
              options={(["left", "right", "none"] as const).map((v) => [v, { left: "Слева", right: "Справа", none: "Скрыть" }[v], <Perch side={v} size={p.size} />])} />
            {p.side !== "none" && <>
              <label>Размер</label>
              <Cards label="Размер" value={p.size} onPick={(size) => save({ size })}
                options={(["s", "m", "l"] as const).map((v) => [v, { s: "Меньше", m: "Обычная", l: "Больше" }[v], <Perch side={p.side} size={v} />])} />
            </>}
          </div>
        </Card>

        <Card title="Что на панели" className="reveal">
          <div className="form">
            <div className="wp-checks">
              {SECTIONS.map(([k, name]) => (
                <label key={k} className="row"><input type="checkbox" checked={p.sections[k] !== false} onChange={(e) => save({ sections: { [k]: e.target.checked } })} /> {name}</label>
              ))}
            </div>
            <label>Ближайшие планы — сколько строк над задачами</label>
            <Cards label="Ближайшие планы" value={p.nextCount} onPick={(nextCount) => save({ nextCount })}
              options={([1, 3, 5] as const).map((n) => [n, `${n} ${n === 1 ? "строка" : n === 3 ? "строки" : "строк"}`,
                <div className="wm-next">{PLANS.slice(0, n).map(([when, what], i) => <p key={what} className={`nx${i > 1 ? " ahead" : ""}`}><em>{when}</em>· {what}</p>)}</div>])} />
            <label>Планы дня рядом с горничной</label>
            <Cards label="Планы дня" value={p.plans} onPick={(plans) => save({ plans })} options={[
              ["list", "Список", <Perch side={p.side === "none" ? "right" : p.side} size="s" plans />],
              ["off", "Нет", <Perch side={p.side === "none" ? "right" : p.side} size="s" />],
            ]} />
            <label>Важные даты — показывать заранее<Segment label="Важные даты" value={p.dateLead} onPick={(dateLead) => save({ dateLead })} options={[["0", "В тот день"], ["1", "1 день"], ["3", "3 дня"], ["7", "Неделю"]]} /></label>
          </div>
        </Card>

        <Card title="Вид панели" className="reveal">
          <div className="form">
            <label>Цвет</label>
            <Cards label="Цвет" value={p.accent} onPick={(accent) => save({ accent })}
              options={ACCENTS.map(([v, name]) => [v, name,
                <div className={`wm-acc acc-${v}`}><b><em>1/3</em></b><Row t="Хлеб" /><Row t="Вода" did /></div>])} />
            <label>Размер текста</label>
            <Cards label="Размер текста" value={p.textSize} onPick={(textSize) => save({ textSize })}
              options={(["s", "m", "l"] as const).map((v) => [v, { s: "Мельче", m: "Обычный", l: "Крупнее" }[v],
                <div className={`wm-ts ts-${v}`}><p className="nx"><em>14:30</em>· Созвон</p><Row t="Купить хлеб" /><Row t="Оплатить свет" /></div>])} />
          </div>
        </Card>

        <Card title="Задачи" className="reveal">
          <div className="form">
            <label>Сколько задач видно (панель, вытянутая вниз, покажет больше)</label>
            <Cards label="Сколько задач" value={p.taskCount} onPick={(taskCount) => save({ taskCount })}
              options={([4, 6, 10] as const).map((n) => [n, `${n} задач${n === 4 ? "и" : ""}`,
                <div className="wm-count">{TASKS.slice(0, n).map((t) => <Row key={t} t={t} />)}</div>])} />
            <label>Сделанные задачи</label>
            <div className="done-modes" role="radiogroup" aria-label="Сделанные задачи">
              <button role="radio" aria-checked={p.doneTasks === "keep"} className={`dm${p.doneTasks === "keep" ? " on" : ""}`} onClick={() => save({ doneTasks: "keep" })}>
                <div className="dm-mini"><b>Задачи</b><p><i></i>Купить хлеб</p><p className="did"><i>✓</i><s>Пить Аевит</s></p></div>
                <span>Остаются зачёркнутыми</span>
              </button>
              <button role="radio" aria-checked={p.doneTasks === "hide"} className={`dm${p.doneTasks === "hide" ? " on" : ""}`} onClick={() => save({ doneTasks: "hide" })}>
                <div className="dm-mini"><b>Задачи <em>1/2</em></b><p><i></i>Купить хлеб</p><p className="go"><i>✓</i><span>Пить Аевит</span></p></div>
                <span>Улетают, счётчик сделанного</span>
              </button>
            </div>
            <label>Дальние задачи (срок дальше недели)</label>
            <Cards label="Дальние задачи" value={p.laterTasks} onPick={(laterTasks) => save({ laterTasks })} options={[
              ["hide", "Скрывать до срока", <><b>Задачи</b><Row t="Купить хлеб" /><Row t="Оплатить свет" /></>],
              ["show", "Показывать все", <><b>Задачи</b><Row t="Купить хлеб" /><Row t="Оплатить свет" /><p><i></i>Сдать отчёт<span className="wm-due">20 нояб</span></p></>],
            ]} />
            <label>Отмеченные сегодня привычки</label>
            <Cards label="Отмеченные привычки" value={p.doneHabits} onPick={(doneHabits) => save({ doneHabits })} options={[
              ["dim", "Внизу бледным", <><b>Задачи</b><Row t="Зарядка" /><Row t="Купить хлеб" /><Row t="Пить воду" did /></>],
              ["hide", "Не показывать", <><b>Задачи</b><Row t="Зарядка" /><Row t="Купить хлеб" /></>],
            ]} />
            {p.doneHabits === "hide" && <p className="muted small">Снять ошибочную отметку можно на сайте: «Сегодня» → «Каждый день».</p>}
          </div>
        </Card>


        <Card title="Облачко" className="reveal">
          <div className="form">
            <label>Звуки<Segment label="Звуки" value={p.mute ? "off" : "on"} onPick={(v) => { void save({ mute: v === "off" }); setPing((n) => n + 1); }} options={[["on", "Включены"], ["off", "Выключены"]]} /></label>
            <label>Текст в облачке</label>
            <Choices label="Текст в облачке" value={p.typing} onPick={(typing) => { void save({ typing }); setPing((n) => n + 1); }}
              options={[["sound", "Печатает со звуком", "по буквам, с тихим «бип»"], ["quiet", "Печатает тихо", "по буквам, без звука"], ["off", "Сразу целиком", "весь ответ разом"]]} />
            {p.typing !== "off" && <>
              <label>Скорость печати</label>
              <Choices label="Скорость печати" value={p.typeSpeed} onPick={(typeSpeed) => { void save({ typeSpeed }); setPing((n) => n + 1); }}
                options={[["slow", "Медленно", "22 буквы в секунду"], ["normal", "Обычно", "35 букв в секунду"], ["fast", "Быстро", "60 букв в секунду"]]} />
            </>}
            <SayPreview mode={p.typing} speed={p.typeSpeed} side={p.side === "left" ? "left" : "right"} mute={p.mute} ping={ping} />
            <h4 className="wp-sub">Если не ответить</h4>
            <label>Вопрос «добавить?» — сама жмёт «Не надо» через
              <Segment label="«Не надо» через" value={p.proposalWait} onPick={(proposalWait) => save({ proposalWait })} options={[[6, "6 с"], [12, "12 с"], [20, "20 с"], [30, "30 с"]]} />
            </label>
            <label>План на занятое время — сама жмёт «Оставить» через
              <Segment label="«Оставить» через" value={p.clashWait} onPick={(clashWait) => save({ clashWait })} options={[[5, "5 с"], [10, "10 с"], [20, "20 с"], [30, "30 с"]]} />
            </label>
            <p className="muted small">Кнопка заполняется полосой; пока курсор на облачке горничной — ждёт.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
