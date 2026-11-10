import { useEffect, useState } from "react";
import { Card, Empty, Spinner } from "../components";

// Виджет на рабочем столе: что на панели, горничная, задачи, сроки самонажатия кнопок. Настройки живут в программе на ПК
// (desktop/src/preload-app.js → main.js «app:widget-*»), сайт их только показывает и меняет; в браузере и на телефоне раздела нет.

export interface WidgetPrefs {
  show?: boolean; opacity?: number; side?: "left" | "right" | "none"; size?: "s" | "m" | "l";
  sections?: { next?: boolean; habits?: boolean; tasks?: boolean; soon?: boolean };
  plans?: "list" | "off"; dateLead?: "0" | "1" | "3" | "7"; doneTasks?: "keep" | "hide"; laterTasks?: "hide" | "show";
  proposalWait?: number; clashWait?: number; mute?: boolean;
}
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
  plans: "list", dateLead: "1", doneTasks: "keep", laterTasks: "hide", proposalWait: 12, clashWait: 10, mute: false,
};
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
            <label>Где стоит<Segment label="Где стоит" value={p.side} onPick={(side) => save({ side })} options={[["left", "Слева"], ["right", "Справа"], ["none", "Скрыть"]]} /></label>
            <label>Размер<Segment label="Размер" value={p.size} onPick={(size) => save({ size })} options={[["s", "Меньше"], ["m", "Обычная"], ["l", "Больше"]]} /></label>
            <label>Звуки<Segment label="Звуки" value={p.mute ? "off" : "on"} onPick={(v) => save({ mute: v === "off" })} options={[["on", "Включены"], ["off", "Выключены"]]} /></label>
          </div>
        </Card>

        <Card title="Что на панели" className="reveal">
          <div className="form">
            <div className="wp-checks">
              {SECTIONS.map(([k, name]) => (
                <label key={k} className="row"><input type="checkbox" checked={p.sections[k] !== false} onChange={(e) => save({ sections: { [k]: e.target.checked } })} /> {name}</label>
              ))}
            </div>
            <label>Планы дня<Segment label="Планы дня" value={p.plans} onPick={(plans) => save({ plans })} options={[["list", "Список"], ["off", "Нет"]]} /></label>
            <label>Важные даты — показывать заранее<Segment label="Важные даты" value={p.dateLead} onPick={(dateLead) => save({ dateLead })} options={[["0", "В тот день"], ["1", "1 день"], ["3", "3 дня"], ["7", "Неделю"]]} /></label>
          </div>
        </Card>

        <Card title="Задачи" className="reveal">
          <div className="form">
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
            <label>Дальние задачи (срок дальше недели)<Segment label="Дальние задачи" value={p.laterTasks} onPick={(laterTasks) => save({ laterTasks })} options={[["hide", "Скрывать до срока"], ["show", "Показывать все"]]} /></label>
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
