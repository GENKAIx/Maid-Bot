import { useEffect, useState } from "react";
import { get, post } from "../api";
import { Card, Empty, Spinner } from "../components";

// Часть «Рина» вкладки «Персонализация» в «Настройках» (до 19.11.2026 — страница «Персонализация», до 20.11.2026 — вкладка «Горничная»): как и когда горничная с вами общается — характер, внешность (цвет волос и глаз), время сообщений, напоминания о планах, игры.
// Техническое (тема, push, расход модели, вход) — в «Настройках». Кто она — карточка RINA в server/src/personas.ts.

interface Me {
  persona: string;
  morning_time: string; tomorrow_time: string; evening_time: string; habit_first: string; habit_last: string; event_lead_min: number; event_reminders: string;
  game_alerts: number; game_first_min: number; game_every_min: number;
  maid_hair?: string; maid_eyes?: string; // нет у сервера без «Перекрасить Рину» — тогда свои цвета
}
interface PersonaInfo { id: string; name: string; samples: string[] }
type LookPatch = Partial<Pick<Me, "maid_hair" | "maid_eyes">>;
interface LookNote { text: string; bad?: boolean }

// «Перекрасить Рину»: копия LOOK_HAIR / LOOK_EYES из desktop/renderer/look.js без формул — id (как в users.maid_hair /
// maid_eyes), название и образец для кружка, тот же порядок, первый — свой цвет. Сверяет desktop/test/look-ids.test.cjs.
// Картинки — web/public/maid/look/hello-<волосы>-<глаза>.webp: первый кадр hello.webp в этих цветах, 360×384 — вдвое
// больше показа (tools/maid-look/make_previews.py; новый цвет — сначала в look.js, потом сюда и перезапуск скрипта).
const LOOK_HAIR = [
  { id: "red", name: "тёмно-красные", swatch: "#a73241" },
  { id: "brown", name: "каштановые", swatch: "#784e31" },
  { id: "gold", name: "золотистые", swatch: "#e6bb4d" },
  { id: "silver", name: "серебристые", swatch: "#c5cbd7" },
  { id: "violet", name: "фиолетовые", swatch: "#8b44a7" },
  { id: "black", name: "чёрные", swatch: "#54566f" },
];
const LOOK_EYES = [
  { id: "violet", name: "фиолетовые", swatch: "#642c7f" },
  { id: "green", name: "зелёные", swatch: "#2c7f40" },
  { id: "blue", name: "синие", swatch: "#2c547f" },
  { id: "amber", name: "янтарные", swatch: "#b28038" },
];
type LookOption = (typeof LOOK_HAIR)[number];
/** Цвет из настройки; поля нет (старый сервер) или id незнакомый — свой цвет (первый в таблице). */
const lookOf = (table: LookOption[], id: string | undefined) => table.find((o) => o.id === id) ?? table[0];
const lookSrc = (hair: string, eyes: string) => `/maid/look/hello-${hair}-${eyes}.webp`;
// Уже запрошенные заранее картинки: каждая — один раз за жизнь страницы, и ссылка держит Image, пока он грузится.
// Сервер отдаёт /maid/look/* с no-cache и без ETag — браузер качает заново при каждом открытии страницы, поэтому заранее
// грузим, только когда к кружкам подвели мышь или фокус (см. warm в MaidLook), а не при каждом показе.
const lookLoaded = new Map<string, HTMLImageElement>();
function lookPreload(src: string) {
  if (lookLoaded.has(src)) return;
  const img = new Image();
  img.src = src;
  lookLoaded.set(src, img);
}

/** Ряд кружков одного цвета (волосы или глаза): выбор сохраняется сразу, наведение и фокус — показать на картинке. */
function LookRow({ label, table, value, onPeek, onPick }: {
  label: string; table: LookOption[]; value: string; onPeek: (id: string | null) => void; onPick: (id: string) => void;
}) {
  return (
    <div className="look-row">
      <span className="muted small">{label}</span>
      <div className="look-swatches" role="radiogroup" aria-label={label}>
        {table.map((o) => (
          <button key={o.id} role="radio" aria-checked={value === o.id} aria-label={o.name} title={o.name}
            className={`look-swatch${value === o.id ? " on" : ""}`} style={{ background: o.swatch }}
            onPointerEnter={() => onPeek(o.id)} onPointerLeave={() => onPeek(null)} onFocus={() => onPeek(o.id)} onBlur={() => onPeek(null)}
            onClick={() => value !== o.id && onPick(o.id)} />
        ))}
      </div>
    </div>
  );
}

/** Карточка «Внешность»: Рина в выбранных цветах (при наведении на кружок — в тех, на которых он), два ряда кружков
 *  и итог последнего выбора — здесь же, под кружками: общее сообщение страницы на телефоне уже за верхним краем экрана. */
function MaidLook({ hair, eyes, note, onPick }: { hair: string; eyes: string; note: LookNote | null; onPick: (patch: LookPatch) => void }) {
  const [peek, setPeek] = useState<{ hair?: string; eyes?: string } | null>(null);
  const [warm, setWarm] = useState(false);
  const h = lookOf(LOOK_HAIR, peek?.hair ?? hair), e = lookOf(LOOK_EYES, peek?.eyes ?? eyes);
  // Картинки соседних вариантов (поменять волосы или глаза) — в кэш, как только к кружкам подвели мышь или фокус
  // (на телефоне — касание), чтобы при наведении менялись сразу; без интереса к кружкам лишнего не качаем.
  useEffect(() => {
    if (!warm) return;
    for (const o of LOOK_HAIR) lookPreload(lookSrc(o.id, eyes));
    for (const o of LOOK_EYES) lookPreload(lookSrc(hair, o.id));
  }, [warm, hair, eyes]);
  // Свои цвета без наведения — живая анимация, как раньше; остальное — первый кадр той же анимации в новых цветах.
  const own = !peek && h === LOOK_HAIR[0] && e === LOOK_EYES[0];
  return (
    <>
      <div className="maid-look">
        <img className="maid-look-pic" src={own ? "/maid/hello.webp" : lookSrc(h.id, e.id)} alt="" width={180} height={192} />
        <div className="maid-look-side" onPointerEnter={() => setWarm(true)} onFocus={() => setWarm(true)}>
          <p><b>Рина</b>, 22 года. <span className="muted">Волосы {h.name}, глаза {e.name}.</span></p>
          <LookRow label="Волосы" table={LOOK_HAIR} value={hair} onPeek={(id) => setPeek(id ? { hair: id } : null)} onPick={(id) => onPick({ maid_hair: id })} />
          <LookRow label="Глаза" table={LOOK_EYES} value={eyes} onPeek={(id) => setPeek(id ? { eyes: id } : null)} onPick={(id) => onPick({ maid_eyes: id })} />
        </div>
      </div>
      {/* Живая область есть всегда, меняется только текст — так диктор зачитывает и «Сохранено.», и откат цвета. */}
      <div role="status">{note && <div className={`task-note${note.bad ? " bad" : ""}`}>{note.text}</div>}</div>
    </>
  );
}

/** Настройка users.event_reminders: «day» — в начале дня, число — за столько минут, 0 — в момент начала; «off» — никогда; пусто — за event_lead_min и в момент. */
function remindTokens(me: Pick<Me, "event_reminders" | "event_lead_min">): string[] {
  const raw = me.event_reminders.trim() || `${me.event_lead_min},0`;
  return raw === "off" ? [] : [...new Set(raw.split(",").map((t) => t.trim()).filter((t) => t === "day" || /^\d+$/.test(t)))];
}
const leadName = (min: number) =>
  min % 1440 === 0 ? `За ${min / 1440} дн.` : min < 60 ? `За ${min} мин` : min % 60 ? `За ${Math.floor(min / 60)} ч ${min % 60} мин` : `За ${min / 60} ч`;
const REMIND_PRESETS: [string, string][] = [["day", "В начале дня"], ["60", "За час"], ["5", "За 5 минут"], ["0", "В момент события"]];

/** Сколько раз и когда напоминать о плане со временем: готовые варианты и свои. */
function EventReminders({ me, busy, onSave }: { me: Me; busy: boolean; onSave: (v: string) => void }) {
  const on = remindTokens(me);
  const [num, setNum] = useState("30");
  const [unit, setUnit] = useState<"1" | "60" | "1440">("1");
  const own = on.filter((t) => !REMIND_PRESETS.some(([k]) => k === t)).map(Number).sort((a, b) => b - a);
  const put = (list: string[]) => onSave(list.length ? list.join(",") : "off");
  const flip = (t: string) => put(on.includes(t) ? on.filter((x) => x !== t) : [...on, t]);
  const mins = Math.round(Number(num) * Number(unit));
  const okOwn = Number.isFinite(mins) && mins >= 1 && mins <= 7 * 1440 && !on.includes(String(mins));
  return (
    <div className="form">
      <div className="remind-opts" role="group" aria-label="Когда напоминать">
        {REMIND_PRESETS.map(([t, name]) => (
          <button key={t} className={`remind-opt${on.includes(t) ? " on" : ""}`} aria-pressed={on.includes(t)} disabled={busy} onClick={() => flip(t)}>
            {on.includes(t) ? "✓ " : ""}{name}
          </button>
        ))}
        {own.map((m) => (
          <span key={m} className="remind-opt on">
            ✓ {leadName(m)}
            <button className="ghost" aria-label={`Убрать «${leadName(m)}»`} disabled={busy} onClick={() => flip(String(m))}>✕</button>
          </span>
        ))}
      </div>
      <div className="row remind-own">
        <span className="muted small">Свой вариант: за</span>
        <input type="number" min={1} max={unit === "1" ? 10080 : unit === "60" ? 168 : 7} value={num} onChange={(e) => setNum(e.target.value)} aria-label="Сколько" />
        <select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} aria-label="Единица">
          <option value="1">мин</option><option value="60">ч</option><option value="1440">дн.</option>
        </select>
        <button disabled={busy || !okOwn} onClick={() => put([...on, String(mins)])}>Добавить</button>
      </div>
      <p className="muted small">
        {on.length ? `Напомню ${on.length} ${on.length === 1 ? "раз" : on.length < 5 ? "раза" : "раз"}. «В начале дня» — в час утреннего списка (${me.morning_time}). Если момент уже прошёл (план добавлен впритык), это напоминание пропускается.` : "Напоминаний о планах не будет."}
      </p>
    </div>
  );
}

export function MaidSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [personas, setPersonas] = useState<PersonaInfo[] | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [lookNote, setLookNote] = useState<LookNote | null>(null);

  // «Сохранено.» под кружками гаснет само, «не сохранился» висит до следующего выбора.
  useEffect(() => {
    if (!lookNote || lookNote.bad) return;
    const t = setTimeout(() => setLookNote(null), 4000);
    return () => clearTimeout(t);
  }, [lookNote]);

  useEffect(() => {
    Promise.all([get<Me>("/api/me"), get<PersonaInfo[]>("/api/personas")])
      .then(([m, p]) => { setMe(m); setPersonas(p); })
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!me || !personas) return <Spinner />;

  // say — куда сказать итог: по умолчанию общее сообщение вверху страницы.
  async function save(patch: Partial<Me>, say: (text: string, bad?: boolean) => void = setMsg): Promise<Me | null> {
    setSaving(true);
    try {
      const fresh = await post<Me>("/api/settings", patch);
      setMe(fresh);
      say("Сохранено.");
      return fresh;
    } catch (e) {
      say((e as Error).message, true);
      return null;
    } finally {
      setSaving(false);
    }
  }
  // Цвет волос или глаз: кружок и картинка — сразу, сохранение — следом; не вышло — цвет назад и сообщение.
  // Итог — под кружками (lookNote), а не в общем сообщении вверху: на телефоне его там не видно.
  // Пока идёт сохранение, новый щелчок не принимается (кнопки не выключаются — фокус с клавиатуры не теряется).
  async function pickLook(patch: LookPatch) {
    if (saving) return;
    const before: LookPatch = { maid_hair: me!.maid_hair, maid_eyes: me!.maid_eyes };
    setLookNote(null);
    setMe((m) => m && { ...m, ...patch });
    let why = "";
    const fresh = await save(patch, (text, bad) => { if (bad) why = text; });
    if (!fresh) {
      setMe((m) => m && { ...m, ...before });
      setLookNote({ text: `Цвет не сохранился: ${why}`, bad: true });
    } else if (Object.entries(patch).some(([k, v]) => fresh[k as keyof LookPatch] !== v)) {
      setLookNote({ text: "Цвет не сохранился: сервер пока не знает эту настройку.", bad: true });
    } else setLookNote({ text: "Сохранено." });
  }
  const field = (key: keyof Me, type: "time" | "number", extra: Record<string, unknown> = {}) => (
    <input
      type={type} defaultValue={String(me![key])} {...extra}
      onBlur={(e) => e.target.value !== String(me![key]) && save({ [key]: type === "number" ? Number(e.target.value) : e.target.value } as Partial<Me>)}
    />
  );

  return (
    <div className="screen">
      {msg && <div className="toast" style={{ marginTop: 12 }}><div className="toast-text">{msg}</div><button className="ghost" onClick={() => setMsg("")}>✕</button></div>}
      <div className="cards">
        <Card title="Характер" className="reveal">
          <div className="persona-pick" role="radiogroup" aria-label="Характер">
            {personas.map((p) => (
              <button key={p.id} role="radio" aria-checked={me.persona === p.id} className={`persona-opt${me.persona === p.id ? " on" : ""}`}
                disabled={saving} onClick={() => me.persona !== p.id && save({ persona: p.id })}>
                <b>{p.name}</b>
                {p.samples.map((s) => <span key={s} className="muted small">«{s}»</span>)}
              </button>
            ))}
          </div>
        </Card>

        <Card title="Внешность" className="reveal">
          <MaidLook hair={lookOf(LOOK_HAIR, me.maid_hair).id} eyes={lookOf(LOOK_EYES, me.maid_eyes).id} note={lookNote} onPick={pickLook} />
          <p className="muted small look-note">
            Характер меняет только то, как она говорит, а волосы и глаза выбираются здесь: программа на ПК перекрасит все её
            анимации в виджете, и, если спросить, она назовёт свои цвета.
          </p>
        </Card>

        <Card title="Когда писать" className="reveal">
          <div className="form">
            <label>Утренний список {field("morning_time", "time")}</label>
            <label>Что завтра {field("tomorrow_time", "time")}</label>
            <label>Вечерний итог {field("evening_time", "time", { min: "12:00", max: "23:59" })}</label>
            <p className="muted small">Итог — за этот день, поэтому его время — до полуночи, с 12:00 до 23:59 (например 23:55).</p>
            <label>Привычки: первый вопрос {field("habit_first", "time")}</label>
            <label>Привычки: ещё раз, если не ответили {field("habit_last", "time")}</label>
            <p className="muted small">Так горничная спрашивает про привычки без своего времени, а второй вопрос приходит всем неотмеченным. Не ответили до 00:00 — день с минусом. Второй вопрос — позже первого.</p>
          </div>
        </Card>

        <Card title="Когда напоминать о событиях" className="reveal">
          <EventReminders me={me} busy={saving} onSave={(event_reminders) => save({ event_reminders })} />
        </Card>

        <Card title="Игры" className="reveal">
          <div className="form">
            <label className="row"><input type="checkbox" checked={me.game_alerts === 1} onChange={(e) => save({ game_alerts: e.target.checked ? 1 : 0 })} /> Предупреждать об играх</label>
            <label>Первое предупреждение через, мин {field("game_first_min", "number", { min: 15, max: 1440, step: 15 })}</label>
            <label>Дальше каждые, мин {field("game_every_min", "number", { min: 15, max: 1440, step: 15 })}</label>
          </div>
        </Card>
      </div>
    </div>
  );
}
