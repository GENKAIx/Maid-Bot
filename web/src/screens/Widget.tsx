import { type ReactNode, useEffect, useRef, useState } from "react";
import { Empty, Spinner } from "../components";

// Виджет на рабочем столе: что на панели, горничная, задачи, сроки самонажатия кнопок. Настройки живут в программе на ПК
// (desktop/src/preload-app.js → main.js «app:widget-*»), сайт их только показывает и меняет; в браузере и на телефоне раздела нет.

export interface WidgetPrefs {
  show?: boolean; opacity?: number; side?: "left" | "right" | "none"; size?: "s" | "m" | "l";
  sections?: { next?: boolean; habits?: boolean; tasks?: boolean; soon?: boolean };
  plans?: "list" | "off"; dateLead?: "0" | "1" | "3" | "7"; doneTasks?: "keep" | "hide"; laterTasks?: "hide" | "show";
  proposalWait?: number; clashWait?: number; mute?: boolean; typing?: "sound" | "quiet" | "off"; typeSpeed?: "slow" | "normal" | "fast";
  accent?: Accent; textSize?: "s" | "m" | "l"; taskCount?: 4 | 6 | 10; nextCount?: 1 | 3 | 5; doneHabits?: "dim" | "hide";
  napAfter?: 0 | 5 | 15 | 30 | 60; napNight?: boolean; bedtime?: Bedtime; morning?: 6 | 7 | 8 | 9; napRecap?: boolean; napFold?: boolean;
}
type Bedtime = "auto" | "22:00" | "23:00" | "00:00" | "01:00";
/** Общее программы на ПК (раньше — только в меню значка у часов). */
export interface General { autostart: boolean; canAutostart: boolean; keys: { quick: string; grab: string }; error?: string }
type Accent = "violet" | "blue" | "green" | "pink" | "amber";
interface Bridge {
  widget(): Promise<WidgetPrefs | null>;
  saveWidget(patch: WidgetPrefs): Promise<WidgetPrefs | null>;
  resetWidget(): Promise<void>;
  // В старых версиях программы этого нет — тогда раздела «Программа» на странице нет.
  general?(): Promise<General | null>;
  saveGeneral?(patch: { autostart?: boolean; keys?: Partial<General["keys"]> }): Promise<General | null>;
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
  napAfter: 15, napNight: true, bedtime: "auto", morning: 7, napRecap: true, napFold: true,
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

/** Строка настройки, как в Discord: название и пояснение слева, короткий переключатель справа, варианты — под строкой. */
function Setting({ title, hint, side, children }: { title: string; hint?: string; side?: ReactNode; children?: ReactNode }) {
  return (
    <div className="wp-set">
      <div className="wp-set-head"><div className="wp-set-text"><b>{title}</b>{hint && <span>{hint}</span>}</div>{side}</div>
      {children && <div className="wp-set-body">{children}</div>}
    </div>
  );
}
function Toggle({ on, set, label }: { on: boolean; set: (on: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`wp-toggle${on ? " on" : ""}`} onClick={() => set(!on)}><i /></button>;
}

/** Сочетание клавиш Electron («Control+Alt+Space») — по-человечески: «Ctrl + Alt + Пробел». */
const KEY_NAMES: Record<string, string> = { Control: "Ctrl", Super: "Win", Space: "Пробел", Up: "↑", Down: "↓", Left: "←", Right: "→", Delete: "Del", Backspace: "⌫" };
const keyLabel = (k: string) => k.split("+").map((x) => KEY_NAMES[x] ?? x).join(" + ");
/** Нажатие → строка Electron; одни модификаторы — null (ждём основную клавишу). */
function keyOf(e: KeyboardEvent): string | null {
  const c = e.code;
  const main = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c
    : ({ Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp",
      PageDown: "PageDown", Insert: "Insert", Delete: "Delete", Backspace: "Backspace", Tab: "Tab", Enter: "Enter" } as Record<string, string>)[c];
  if (!main) return null;
  return [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", main].filter(Boolean).join("+");
}
/** Кнопка с сочетанием: щёлкнули — ждёт нажатия, Esc — отмена. */
function KeyPicker({ value, onPick, label }: { value: string; onPick: (key: string) => void; label: string }) {
  const [wait, setWait] = useState(false);
  useEffect(() => {
    if (!wait) return;
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) return setWait(false);
      const k = keyOf(e);
      if (!k) return;
      setWait(false);
      if (k !== value) onPick(k);
    };
    const off = () => setWait(false);
    addEventListener("keydown", down, true);
    addEventListener("blur", off);
    return () => { removeEventListener("keydown", down, true); removeEventListener("blur", off); };
  }, [wait, value, onPick]);
  return (
    <button className={`wp-key${wait ? " wait" : ""}`} aria-label={`${label}: ${keyLabel(value)}. Изменить`} onClick={() => setWait((w) => !w)} onBlur={() => setWait(false)}>
      {wait ? "Нажмите сочетание… (Esc — отмена)" : value.split("+").map((x, i) => <kbd key={i}>{KEY_NAMES[x] ?? x}</kbd>)}
    </button>
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

/** Живая копия облачка с самонажатием (desktop/renderer/widget.js: startProposal, startAuto): облачко появляется, кнопка
 *  заполняется за выбранные секунды, пока курсор на облачке — стоит; дошла — «Не надо» закрывает облачко, «Оставить» вспыхивает,
 *  нажимается и горничная отвечает. По кругу. */
function AutoPreview({ kind, wait, side, ping }: { kind: "add" | "clash"; wait: number; side: "left" | "right"; ping: number }) {
  const [t, setT] = useState(0);
  const [hover, setHover] = useState(false);
  const clock = useRef({ t: 0, last: 0, hover: false });
  clock.current.hover = hover;
  const GAP = 800, POP = 250, FILL = wait * 1000, PRESS = 380, REPLY = 1800, FADE = 300;
  const cycle = GAP + POP + FILL + (kind === "clash" ? PRESS + REPLY : 0) + FADE;
  useEffect(() => {
    const c = clock.current;
    c.t = 0;
    c.last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - c.last;
      c.last = now;
      const at = c.t % cycle;
      // Как в виджете: пока курсор на облачке, время кнопки стоит.
      if (!(c.hover && at >= GAP + POP && at < GAP + POP + FILL)) c.t += dt;
      setT(c.t);
    }, 16);
    return () => clearInterval(id);
  }, [kind, wait, ping, cycle]);
  const c = t % cycle;
  const since = c - GAP - POP;
  const up = c >= GAP && c < cycle - FADE;
  const filled = Math.max(0, Math.min(1, since / FILL));
  const pressed = kind === "clash" && since >= FILL && since < FILL + PRESS;
  const replied = kind === "clash" && since >= FILL + PRESS;
  const left = Math.max(0, Math.ceil((FILL - Math.max(0, since)) / 1000));
  const holding = hover && since >= 0 && since < FILL;
  return (
    <div className={`wp-say wp-ask side-${side}`} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <div className="wp-say-hint">{!up || since < 0 ? "" : holding ? "⏸ курсор на облачке — ждёт" : since < FILL ? `нажмёт сама через ${left} с · наведите — пауза` : kind === "add" ? "нажала «Не надо» — облачко закрылось" : "нажала «Оставить»"}</div>
      <div className={`wp-say-bubble rich${up ? " up" : ""}${c >= cycle - FADE ? " out" : ""}`} key={Math.floor(t / cycle)}>
        {replied ? <p>Хорошо, оставила оба.</p> : kind === "add" ? <>
          <div className="wp-ask-list">
            <label><i>✓</i><span><b>Купить хлеб</b><em>завтра к 10:00</em></span></label>
            <label><i>✓</i><span><b>Позвонить маме</b><em>сегодня вечером</em></span></label>
          </div>
          <p>Добавить в планы?</p>
          <div className="wp-ask-acts">
            <button tabIndex={-1} className="yes">✅ Добавить</button>
            <button tabIndex={-1} className="no"><span className="bar" style={{ transform: `scaleX(${filled})` }} />Не надо</button>
          </div>
        </> : <>
          <p>В 14:30 уже «Созвон». Сдвинуть «Врач» на 15:00?</p>
          <div className="wp-ask-acts">
            <button tabIndex={-1}>➜ Сдвинуть на 15:00</button>
            <button tabIndex={-1} className={`auto${pressed ? " pressed" : ""}`}><span className="fill" style={{ transform: `scaleX(${filled})` }} />Оставить</button>
          </div>
        </>}
      </div>
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
  const [ask, setAsk] = useState<"add" | "clash">("add"); // какой пример самонажатия показать
  const [gen, setGen] = useState<General | null>(null);

  useEffect(() => {
    if (!bridge) return;
    void bridge.widget().then((w) => {
      const all = { ...DEFAULTS, ...w, sections: { ...DEFAULTS.sections, ...w?.sections } };
      setP(all);
      setOpacity(all.opacity);
    });
    void bridge.general?.().then(setGen).catch(() => null);
  }, [bridge]);

  if (!bridge) return <Empty>Виджет — это программа «Горничная» на компьютере. Его настройки — в ней: раздел «Виджет» слева.</Empty>;
  if (!p) return <Spinner />;

  async function save(patch: WidgetPrefs) {
    setP((x) => ({ ...x!, ...patch, sections: { ...x!.sections, ...patch.sections } }));
    const r = await bridge!.saveWidget(patch).catch(() => null);
    if (!r) setMsg("Не сохранилось: перезапустите программу «Горничная».");
  }
  async function saveGen(patch: { autostart?: boolean; keys?: Partial<General["keys"]> }) {
    const r = await bridge!.saveGeneral?.(patch).catch(() => null);
    if (!r) return setMsg("Не сохранилось: перезапустите программу «Горничная».");
    setGen(r);
    setMsg(r.error ?? "");
  }

  return (
    <div className="screen wp">
      <h2 className="screen-title">Виджет</h2>
      <p className="muted small">Панель с горничной на рабочем столе этого компьютера. Меняется сразу; на других устройствах — свои настройки.</p>
      {msg && <div className="toast" style={{ marginTop: 12 }}><div className="toast-text">{msg}</div><button className="ghost" onClick={() => setMsg("")}>✕</button></div>}
      <div className="wp-list">
        <section className="wp-sec reveal">
          <h3>Окно</h3>
          <Setting title="Поверх всех окон" hint="Виджет не прячется за другими программами"
            side={<Toggle label="Поверх всех окон" on={p.show} set={(show) => save({ show })} />} />
          <Setting title="Непрозрачность панели" hint="Насколько сквозь панель видно рабочий стол" side={<b className="wp-val">{Math.round(opacity * 100)}%</b>}>
            <input type="range" min={0.4} max={1} step={0.02} value={opacity} aria-label="Непрозрачность панели" onChange={(e) => setOpacity(Number(e.target.value))}
              onPointerUp={() => save({ opacity })} onKeyUp={() => save({ opacity })} />
          </Setting>
          <Setting title="Положение на экране" hint="Если виджет потерялся или ушёл за край"
            side={<button onClick={() => { void bridge.resetWidget(); setMsg("Виджет вернулся в правый нижний угол."); }}>Вернуть в угол</button>} />
        </section>

        <section className="wp-sec reveal">
          <h3>Горничная</h3>
          <Setting title="Где стоит">
            <Cards label="Где стоит" value={p.side} onPick={(side) => save({ side })}
              options={(["left", "right", "none"] as const).map((v) => [v, { left: "Слева", right: "Справа", none: "Скрыть" }[v], <Perch side={v} size={p.size} />])} />
          </Setting>
          {p.side !== "none" && <Setting title="Размер">
            <Cards label="Размер" value={p.size} onPick={(size) => save({ size })}
              options={(["s", "m", "l"] as const).map((v) => [v, { s: "Меньше", m: "Обычная", l: "Больше" }[v], <Perch side={p.side} size={v} />])} />
          </Setting>}
        </section>

        <section className="wp-sec reveal">
          <h3>Что на панели</h3>
          {SECTIONS.map(([k, name]) => (
            <Setting key={k} title={name} side={<Toggle label={name} on={p.sections[k] !== false} set={(on) => save({ sections: { [k]: on } })} />} />
          ))}
          <Setting title="Ближайшие планы" hint="Сколько строк над задачами">
            <Cards label="Ближайшие планы" value={p.nextCount} onPick={(nextCount) => save({ nextCount })}
              options={([1, 3, 5] as const).map((n) => [n, `${n} ${n === 1 ? "строка" : n === 3 ? "строки" : "строк"}`,
                <div className="wm-next">{PLANS.slice(0, n).map(([when, what], i) => <p key={what} className={`nx${i > 1 ? " ahead" : ""}`}><em>{when}</em>· {what}</p>)}</div>])} />
          </Setting>
          <Setting title="Планы дня рядом с горничной">
            <Cards label="Планы дня" value={p.plans} onPick={(plans) => save({ plans })} options={[
              ["list", "Список", <Perch side={p.side === "none" ? "right" : p.side} size="s" plans />],
              ["off", "Нет", <Perch side={p.side === "none" ? "right" : p.side} size="s" />],
            ]} />
          </Setting>
          <Setting title="Важные даты" hint="За сколько показывать заранее"
            side={<Segment label="Важные даты" value={p.dateLead} onPick={(dateLead) => save({ dateLead })} options={[["0", "В тот день"], ["1", "1 день"], ["3", "3 дня"], ["7", "Неделю"]]} />} />
        </section>

        <section className="wp-sec reveal">
          <h3>Вид панели</h3>
          <Setting title="Цвет">
            <Cards label="Цвет" value={p.accent} onPick={(accent) => save({ accent })}
              options={ACCENTS.map(([v, name]) => [v, name,
                <div className={`wm-acc acc-${v}`}><b><em>1/3</em></b><Row t="Хлеб" /><Row t="Вода" did /></div>])} />
          </Setting>
          <Setting title="Размер текста">
            <Cards label="Размер текста" value={p.textSize} onPick={(textSize) => save({ textSize })}
              options={(["s", "m", "l"] as const).map((v) => [v, { s: "Мельче", m: "Обычный", l: "Крупнее" }[v],
                <div className={`wm-ts ts-${v}`}><p className="nx"><em>14:30</em>· Созвон</p><Row t="Купить хлеб" /><Row t="Оплатить свет" /></div>])} />
          </Setting>
        </section>

        <section className="wp-sec reveal">
          <h3>Задачи</h3>
          <Setting title="Сколько задач видно" hint="Панель, вытянутая вниз, покажет больше">
            <Cards label="Сколько задач" value={p.taskCount} onPick={(taskCount) => save({ taskCount })}
              options={([4, 6, 10] as const).map((n) => [n, `${n} задач${n === 4 ? "и" : ""}`,
                <div className="wm-count">{TASKS.slice(0, n).map((t) => <Row key={t} t={t} />)}</div>])} />
          </Setting>
          <Setting title="Сделанные задачи">
            <Cards label="Сделанные задачи" value={p.doneTasks} onPick={(doneTasks) => save({ doneTasks })} options={[
              ["keep", "Остаются зачёркнутыми", <><b>Задачи</b><p><i></i>Купить хлеб</p><p className="did"><i>✓</i><s>Пить Аевит</s></p></>],
              ["hide", "Улетают, счётчик сделанного", <><b>Задачи <em>1/2</em></b><p><i></i>Купить хлеб</p><p className="go"><i>✓</i><span>Пить Аевит</span></p></>],
            ]} />
          </Setting>
          <Setting title="Дальние задачи" hint="Срок дальше недели">
            <Cards label="Дальние задачи" value={p.laterTasks} onPick={(laterTasks) => save({ laterTasks })} options={[
              ["hide", "Скрывать до срока", <><b>Задачи</b><Row t="Купить хлеб" /><Row t="Оплатить свет" /></>],
              ["show", "Показывать все", <><b>Задачи</b><Row t="Купить хлеб" /><Row t="Оплатить свет" /><p><i></i>Сдать отчёт<span className="wm-due">20 нояб</span></p></>],
            ]} />
          </Setting>
          <Setting title="Отмеченные сегодня привычки"
            hint={p.doneHabits === "hide" ? "Снять ошибочную отметку можно на сайте: «Сегодня» → «Каждый день»." : undefined}>
            <Cards label="Отмеченные привычки" value={p.doneHabits} onPick={(doneHabits) => save({ doneHabits })} options={[
              ["dim", "Внизу бледным", <><b>Задачи</b><Row t="Зарядка" /><Row t="Купить хлеб" /><Row t="Пить воду" did /></>],
              ["hide", "Не показывать", <><b>Задачи</b><Row t="Зарядка" /><Row t="Купить хлеб" /></>],
            ]} />
          </Setting>
        </section>

        <section className="wp-sec reveal">
          <h3>Облачко</h3>
          <Setting title="Так это выглядит" hint="Меняйте настройки ниже — облачко покажет сразу">
            <SayPreview mode={p.typing} speed={p.typeSpeed} side={p.side === "left" ? "left" : "right"} mute={p.mute} ping={ping} />
          </Setting>
          <Setting title="Звуки" hint="Все звуки виджета"
            side={<Toggle label="Звуки" on={!p.mute} set={(on) => { void save({ mute: !on }); setPing((n) => n + 1); }} />} />
          <Setting title="Текст в облачке">
            <Choices label="Текст в облачке" value={p.typing} onPick={(typing) => { void save({ typing }); setPing((n) => n + 1); }}
              options={[["sound", "Печатает со звуком", "по буквам, с тихим «бип»"], ["quiet", "Печатает тихо", "по буквам, без звука"], ["off", "Сразу целиком", "весь ответ разом"]]} />
          </Setting>
          {p.typing !== "off" && <Setting title="Скорость печати">
            <Choices label="Скорость печати" value={p.typeSpeed} onPick={(typeSpeed) => { void save({ typeSpeed }); setPing((n) => n + 1); }}
              options={[["slow", "Медленно", "22 буквы в секунду"], ["normal", "Обычно", "35 букв в секунду"], ["fast", "Быстро", "60 букв в секунду"]]} />
          </Setting>}
        </section>

        <section className="wp-sec reveal">
          <h3>Если не ответить</h3>
          <Setting title="Так это выглядит" hint="Кнопка заполняется полосой; пока курсор на облачке — ждёт"
            side={<Segment label="Пример" value={ask} onPick={(v) => { setAsk(v); setPing((n) => n + 1); }} options={[["add", "«Добавить?»"], ["clash", "Занятое время"]]} />}>
            <AutoPreview kind={ask} wait={ask === "add" ? p.proposalWait : p.clashWait} side={p.side === "left" ? "left" : "right"} ping={ping} />
          </Setting>
          <Setting title="Вопрос «добавить?»" hint="Сама жмёт «Не надо» через"
            side={<Segment label="«Не надо» через" value={p.proposalWait} onPick={(proposalWait) => { void save({ proposalWait }); setAsk("add"); setPing((n) => n + 1); }} options={[[6, "6 с"], [12, "12 с"], [20, "20 с"], [30, "30 с"]]} />} />
          <Setting title="План на занятое время" hint="Сама жмёт «Оставить» через"
            side={<Segment label="«Оставить» через" value={p.clashWait} onPick={(clashWait) => { void save({ clashWait }); setAsk("clash"); setPing((n) => n + 1); }} options={[[5, "5 с"], [10, "10 с"], [20, "20 с"], [30, "30 с"]]} />} />
        </section>

        <section className="wp-sec reveal">
          <h3>Сон</h3>
          <Setting title="Засыпает, если вас нет" hint={p.napAfter ? "Компьютер не трогали — дремлет и молчит, уведомления копит в ящике" : "Не спит, даже если вы ушли"}
            side={<Segment label="Засыпает через" value={p.napAfter} onPick={(napAfter) => save({ napAfter })} options={[[5, "5 мин"], [15, "15 мин"], [30, "30 мин"], [60, "Час"], [0, "Не засыпать"]]} />} />
          {p.napAfter !== 0 && <>
            <Setting title="Ночью засыпает быстрее" hint="После отбоя — уже через 3 минуты"
              side={<Toggle label="Ночью засыпает быстрее" on={p.napNight} set={(napNight) => save({ napNight })} />} />
            <Setting title="Отбой" hint={p.bedtime === "auto" ? "Узнаёт сама: когда вечером вы надолго уходите от компьютера" : "С этого часа — ночь: не суетится, без чая и уборки"}
              side={<Segment label="Отбой" value={p.bedtime} onPick={(bedtime) => save({ bedtime })} options={[["auto", "Сама"], ["22:00", "22:00"], ["23:00", "23:00"], ["00:00", "00:00"], ["01:00", "01:00"]]} />} />
            <Setting title="Утро" hint="До этого часа ещё ночь"
              side={<Segment label="Утро" value={p.morning} onPick={(morning) => save({ morning })} options={[[6, "6:00"], [7, "7:00"], [8, "8:00"], [9, "9:00"]]} />} />
            <Setting title="Сворачивать панель во сне" hint="Засыпая, сворачивает панель в карточку, проснувшись — разворачивает"
              side={<Toggle label="Сворачивать панель во сне" on={p.napFold} set={(napFold) => save({ napFold })} />} />
            <Setting title="Рассказывать, что было" hint="Проснувшись, пересказывает, что пришло, пока вас не было"
              side={<Toggle label="Рассказывать, что было" on={p.napRecap} set={(napRecap) => save({ napRecap })} />} />
          </>}
        </section>

        {gen && <section className="wp-sec reveal">
          <h3>Программа</h3>
          <Setting title="Запускать с Windows" hint={gen.canAutostart ? "Горничная появляется сама, когда вы включаете компьютер" : "Работает в установленной программе"}
            side={<Toggle label="Запускать с Windows" on={gen.autostart} set={(autostart) => void saveGen({ autostart })} />} />
          <Setting title="Быстрая запись" hint="Окошко, чтобы написать горничной из любой программы"
            side={<KeyPicker label="Быстрая запись" value={gen.keys.quick} onPick={(quick) => void saveGen({ keys: { quick } })} />} />
          <Setting title="Взять или отпустить виджет" hint="Виджет ловит мышь — его можно двигать и нажимать"
            side={<KeyPicker label="Взять или отпустить виджет" value={gen.keys.grab} onPick={(grab) => void saveGen({ keys: { grab } })} />} />
        </section>}
      </div>
    </div>
  );
}
