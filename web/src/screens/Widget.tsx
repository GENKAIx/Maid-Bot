import { type ReactNode, useEffect, useState } from "react";
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

export function Widget() {
  const bridge = desktop();
  const [p, setP] = useState<Required<WidgetPrefs> | null>(null);
  const [opacity, setOpacity] = useState(DEFAULTS.opacity);
  const [msg, setMsg] = useState("");

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
            <label>Звуки<Segment label="Звуки" value={p.mute ? "off" : "on"} onPick={(v) => save({ mute: v === "off" })} options={[["on", "Включены"], ["off", "Выключены"]]} /></label>
            <label>Текст в облачке<Segment label="Текст в облачке" value={p.typing} onPick={(typing) => save({ typing })} options={[["sound", "Печатает со звуком"], ["quiet", "Печатает тихо"], ["off", "Сразу целиком"]]} /></label>
            {p.typing !== "off" && <label>Скорость печати<Segment label="Скорость печати" value={p.typeSpeed} onPick={(typeSpeed) => save({ typeSpeed })} options={[["slow", "Медленно"], ["normal", "Обычно"], ["fast", "Быстро"]]} /></label>}
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

        <Card title="Если не ответить" className="reveal">
          <div className="form">
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
