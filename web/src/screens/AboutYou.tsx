import { useEffect, useRef, useState, type ReactNode } from "react";
import { get, post } from "../api";
import { Card, Empty, Spinner } from "../components";
import { navigate } from "../router";

// Часть «О вас» вкладки «Персонализация» (20.11.2026): что Рине знать о человеке, чтобы помогать точнее. Каждое поле что-то
// включает, ни одно не обязательно; у каждого «?» — зачем оно, куда уходит и что будет, если стереть (на ПК — наведением,
// на телефоне — касанием). Одно поле — одно место: день рождения и рост правятся здесь, значки профиля ведут сюда.
// Сервер — server/src/you.ts (GET/POST /api/you, GET /api/city).

interface City { name: string; region: string; country: string; lat: number; lon: number; tz: string }
type FieldKey = "city" | "wake" | "address" | "bed" | "birthday" | "height" | "tz";
interface You {
  name: string; address: "master" | "mistress" | "name"; call: string;
  city: City | null; tz: string; tz_offset: string; tz_default: string; tz_from_city: boolean;
  /** Подъём «06:30» (с 20.11.2026 — любое своё время), отбой — «auto» или «23:45». */
  wake: string; bed: string; birthday: string; height: number | null; weight: number | null;
  filled: FieldKey[]; traits: { debuffs: number; buffs: number };
}
type Patch = Partial<{ address: You["address"] | null; name: string; city: City | null; tz: string | null; wake: string | null; bed: string | null; birthday: string; height: number | null }>;

const TOTAL = 7;
/** «Зачем», «Куда уходит», «Убрать» — подсказка у «?». */
const TIPS: Record<FieldKey, [string, string, string]> = {
  address: ["Так Рина обращается к вам в ответах, в Telegram и в облачке на ПК.", "Хранится на нашем сервере. Уходит в запрос к модели, которая пишет ответы, — как и всё, что вы ей пишете.", "Стереть — снова «хозяин»."],
  birthday: ["Возраст в профиле.", "Только на нашем сервере, никуда не уходит.", "Стереть — возраст пропадёт."],
  city: ["Часовой пояс подберётся сам. Потом по городу Рина будет говорить погоду.", "Название — нашему серверу, координаты города — сервису погоды Open-Meteo. Ни имени, ни дел.", "Стереть — пояс, взятый от города, снова московский."],
  tz: ["Чтобы напоминания, утренний список и вечерний итог приходили в ваше время, а не по Москве.", "Только на нашем сервере.", "Стереть — снова Москва."],
  wake: ["С этого времени у Рины на ПК утро: она просыпается. Раньше — ночь. На «Утренний список» не влияет: его время — в части «Рина», «Когда писать».", "Только на нашем сервере; виджет на каждом ПК берёт его оттуда.", "Стереть — 7:00, как по умолчанию."],
  bed: ["С этого времени на ПК ночь: Рина не суетится и засыпает быстрее. «Сама» — узнаёт, когда вы вечером надолго уходите от ПК.", "Только на нашем сервере; виджет на каждом ПК берёт его оттуда.", "Стереть — снова «сама»."],
  height: ["Вместе с весом — ИМТ в профиле.", "Только на нашем сервере, никуда не уходит.", "Стереть — ИМТ пропадёт."],
};
const NEXT: Record<FieldKey, string> = {
  city: "Укажите город — часы встанут по вашему поясу.",
  wake: "Укажите подъём — до этого времени Рина на ПК спит.",
  address: "Выберите обращение — если «хозяин» не нравится, Рина будет звать вас иначе.",
  bed: "Укажите отбой — ночью Рина будет тише.",
  birthday: "Укажите день рождения — появится возраст.",
  height: "Укажите рост — появится ИМТ.",
  tz: "Укажите часовой пояс — сообщения придут в ваше время.",
};
const ORDER: FieldKey[] = ["city", "wake", "address", "bed", "birthday", "height", "tz"];
// Готовые варианты подъёма и отбоя; рядом — поле своего времени с минутами (20.11.2026). Границы — как на сервере (you.ts).
const WAKES: [string, string][] = ["05:00", "06:00", "07:00", "08:00", "09:00", "10:00"].map((t) => [t, t.replace(/^0/, "")]);
const BEDS: [string, string][] = [["auto", "Сама"], ["21:00", "21"], ["22:00", "22"], ["23:00", "23"], ["00:00", "00"], ["01:00", "01"], ["02:00", "02"]];
/** «06:30» → «6:30». */
const short = (t: string) => t.replace(/^0(\d)/, "$1");
/** Пояса России и соседей — на выбор вручную; свой пояс города, если его нет в списке, добавляется в начало. */
const ZONES: [string, string][] = [
  ["Europe/Kaliningrad", "Калининград"], ["Europe/Moscow", "Москва"], ["Europe/Samara", "Самара"], ["Asia/Yekaterinburg", "Екатеринбург"],
  ["Asia/Omsk", "Омск"], ["Asia/Novosibirsk", "Новосибирск"], ["Asia/Krasnoyarsk", "Красноярск"], ["Asia/Irkutsk", "Иркутск"],
  ["Asia/Yakutsk", "Якутск"], ["Asia/Vladivostok", "Владивосток"], ["Asia/Magadan", "Магадан"], ["Asia/Kamchatka", "Камчатка"],
  ["Europe/Minsk", "Минск"], ["Europe/Kyiv", "Киев"], ["Asia/Almaty", "Алматы"], ["Asia/Tashkent", "Ташкент"], ["Asia/Tbilisi", "Тбилиси"],
  ["Europe/Berlin", "Берлин"], ["Europe/London", "Лондон"], ["America/New_York", "Нью-Йорк"],
];
/** «UTC+5» по поясу — как на сервере (tzOffset). */
function offsetOf(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = part.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return "UTC+0";
    return `UTC${m[1] === "-" ? "−" : "+"}${Number(m[2])}${m[3] === "00" ? "" : `:${m[3]}`}`;
  } catch {
    return tz;
  }
}
const cityLine = (c: City) => [c.name, c.region && c.region !== c.name ? c.region : "", c.country].filter(Boolean).join(", ");
const dateRu = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** «?» у поля: наведение на ПК, касание на телефоне; щелчок мимо закрывает. */
function Why({ k, label }: { k: FieldKey; label: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener("pointerdown", off);
    return () => removeEventListener("pointerdown", off);
  }, [open]);
  const [why, where, del] = TIPS[k];
  return (
    <span ref={box} className={`you-q${open ? " open" : ""}`}>
      <button type="button" aria-label={`Зачем: ${label}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>?</button>
      <span className="you-tip" role="tooltip">
        <span><b>Зачем.</b> {why}</span>
        <span><b>Куда уходит.</b> {where}</span>
        <span><b>Убрать.</b> {del}</span>
      </span>
    </span>
  );
}

/** Строка поля в одну линию (компактно, 20.11.2026): слева значок, название, «?» и под ними значение с ✕, справа — правка.
 *  На телефоне правка — под значением. */
function Row({ k, icon, label, on, value, onClear, children }: {
  k: FieldKey; icon: string; label: string; on: boolean; value: ReactNode; onClear?: () => void; children?: ReactNode;
}) {
  return (
    <div className={`you-row${on ? " on" : ""}`} data-k={k}>
      <div className="you-row-head">
        <span className="you-ic" aria-hidden="true">{icon}</span>
        <span className="you-l">{label}</span>
        <Why k={k} label={label} />
        <span className="you-val">
          <span className={`you-v${on ? "" : " empty"}`}>{value}</span>
          {on && onClear && <button type="button" className="ghost you-x" aria-label={`Стереть: ${label}`} title="Стереть" onClick={onClear}>✕</button>}
        </span>
      </div>
      {children && <div className="you-row-body">{children}</div>}
    </div>
  );
}

function Pick<T extends string | number>({ value, options, onPick, label }: { value: T | null; options: [T, string][]; onPick: (v: T) => void; label: string }) {
  return (
    <div className="segment you-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, name]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => value !== v && onPick(v)}>{name}</button>
      ))}
    </div>
  );
}

/** Своё время рядом с готовыми вариантами: сохраняется, когда поле покинули (или Enter); пустое — прежнее остаётся.
 *  Шаг — 5 минут; границы проверяет сервер, ошибка — в строке над полосой. */
function OwnTime({ value, label, min, max, onSave }: { value: string; label: string; min?: string; max?: string; onSave: (t: string) => void }) {
  return (
    <input type="time" className={`you-time${value ? " on" : ""}`} step={300} aria-label={label} title={label} defaultValue={value} key={value} min={min} max={max}
      onBlur={(e) => { if (!e.target.value) { e.target.value = value; return; } if (e.target.value !== value) onSave(e.target.value); }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
  );
}

/** Поиск города: от 2 букв, с паузой 300 мс; выбор — сразу в профиль. */
function CitySearch({ onPick }: { onPick: (c: City) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<City[] | null>(null);
  const [bad, setBad] = useState("");
  useEffect(() => {
    if (q.trim().length < 2) { setList(null); setBad(""); return; }
    let alive = true;
    const t = setTimeout(() => {
      get<City[]>(`/api/city?q=${encodeURIComponent(q.trim())}`)
        .then((r) => { if (alive) { setList(r); setBad(""); } })
        .catch(() => { if (alive) { setList(null); setBad("Поиск городов не отвечает, попробуйте позже."); } });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  return (
    <div className="you-city">
      <input value={q} maxLength={60} placeholder="Начните писать: Екатеринбург" aria-label="Город" onChange={(e) => setQ(e.target.value)} />
      {bad && <p className="muted small">{bad}</p>}
      {list && (list.length ? (
        <ul className="you-city-list">
          {list.map((c) => (
            <li key={`${c.lat},${c.lon}`}><button type="button" onClick={() => { onPick(c); setQ(""); setList(null); }}>
              <b>{c.name}</b> <span className="muted small">{[c.region, c.country].filter(Boolean).join(", ")} · {offsetOf(c.tz)}</span>
            </button></li>
          ))}
        </ul>
      ) : <p className="muted small">Такого города не нашлось.</p>)}
    </div>
  );
}

/** onChanged — после каждого сохранения: меню перечитывает счётчик «2/7» (App.tsx). */
export function AboutYou({ onChanged }: { onChanged?: () => void }) {
  const [you, setYou] = useState<You | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  // Сохранения — по очереди: щелчок, пришедший во время сохранения (например, сразу после ухода с поля), не теряется.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const [name, setName] = useState("");
  const [height, setHeight] = useState("");

  useEffect(() => {
    get<You>("/api/you").then((v) => { setYou(v); setName(v.name); setHeight(v.height ? String(v.height) : ""); }).catch((e) => setError((e as Error).message));
  }, []);
  // «Сохранено.» гаснет само, ошибка висит до следующей правки.
  useEffect(() => {
    if (!note || note.bad) return;
    const t = setTimeout(() => setNote(null), 3000);
    return () => clearTimeout(t);
  }, [note]);

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!you) return <Spinner />;

  // said — что сказать после сохранения; функция — по ответу сервера (например, какой пояс он на самом деле поставил).
  function save(patch: Patch, said: string | ((v: You) => string) = "Сохранено.") {
    chain.current = chain.current.then(async () => {
      try {
        const v = await post<You>("/api/you", patch);
        setYou(v);
        setHeight(v.height ? String(v.height) : "");
        setNote({ text: typeof said === "function" ? said(v) : said });
        onChanged?.();
      } catch (e) {
        setNote({ text: (e as Error).message, bad: true });
      }
    });
  }
  const has = (k: FieldKey) => you.filled.includes(k);
  const n = you.filled.length;
  const next = ORDER.find((k) => !has(k));
  const zones = ZONES.some(([z]) => z === you.tz) ? ZONES : [[you.tz, you.city?.name ?? you.tz] as [string, string], ...ZONES];
  const addrText = you.address === "mistress" ? "«хозяйка»" : you.address === "name" ? `по имени — «${you.call}»` : "«хозяин»";
  const commitHeight = () => {
    const h = height.trim() ? Number(height) : null;
    if (h !== you.height) save({ height: h }); // границы проверяет сервер (saveProfile), ошибка — в строке над полосой
  };

  return (
    <div className="cards you">
      {/* Полоса «Заполнено» — тонкой строкой, а не карточкой (20.11.2026: было много пустого места). */}
      <div className="you-progress reveal">
        <b className="you-count">{n} из {TOTAL}</b>
        <div className="you-bar" aria-hidden="true"><i style={{ width: `${(n / TOTAL) * 100}%` }} /></div>
        <p className="muted small">
          {next ? <><b>Дальше:</b> {NEXT[next]}</> : <><b>Всё заполнено.</b> Поменять любое поле можно здесь же.</>}{" "}
          <span title="Пустое поле — функция выключена или работает как по умолчанию.">Ничего не обязательно.</span>
        </p>
        {note && <span className={`small you-note${note.bad ? " bad" : " muted"}`} role="status">{note.text}</span>}
      </div>

      <Card title="Как к вам обращаться" className="reveal">
        <Row k="address" icon="🙋" label="Обращение" on={has("address")} value={has("address") ? addrText : "«хозяин» — по умолчанию"} onClear={() => save({ address: null })}>
          <Pick label="Обращение" value={has("address") ? you.address : null} onPick={(a) => save({ address: a, ...(a === "name" ? { name } : {}) })}
            options={[["master", "Хозяин"], ["mistress", "Хозяйка"], ["name", "По имени"]]} />
          {(you.address === "name" || !you.name.trim()) && (
            <label className="you-name">Имя
              <input value={name} maxLength={80} placeholder="Как вас зовут" onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() !== you.name && name.trim() && save({ name: name.trim() })} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            </label>
          )}
        </Row>
        <Row k="birthday" icon="🎂" label="День рождения" on={has("birthday")} value={has("birthday") ? dateRu(you.birthday) : "не указан"} onClear={() => save({ birthday: "" })}>
          <input type="date" aria-label="Дата рождения" defaultValue={you.birthday} key={you.birthday} min="1900-01-01" max={new Date().toISOString().slice(0, 10)}
            onBlur={(e) => {
              // Недописанная или пустая дата — прежняя остаётся (стереть — крестиком ✕).
              if (!e.target.value) { e.target.value = you.birthday; return; }
              if (e.target.value !== you.birthday) save({ birthday: e.target.value });
            }} />
        </Row>
      </Card>

      <Card title="Где вы" className="reveal">
        <Row k="city" icon="🏙" label="Город" on={has("city")} value={you.city ? cityLine(you.city) : "не указан"} onClear={() => save({ city: null }, "Город стёрт.")}>
          <CitySearch onPick={(c) => save({ city: c }, (v) => (v.tz !== you.tz ? `Записала: ${c.name}. Часы — по ${v.tz_offset}.` : `Записала: ${c.name}.`))} />
        </Row>
        <Row k="tz" icon="🕒" label="Часовой пояс" on={has("tz")} value={`${you.tz_offset}${you.tz_from_city ? ", по городу" : you.tz === you.tz_default ? " — Москва, по умолчанию" : ""}`}
          onClear={() => save({ tz: null })}>
          <select aria-label="Часовой пояс" value={you.tz} onChange={(e) => save({ tz: e.target.value })}>
            {zones.map(([z, title]) => <option key={z} value={z}>{title} · {offsetOf(z)}</option>)}
          </select>
        </Row>
      </Card>

      <Card title="Ваш день" className="reveal">
        <Row k="wake" icon="⏰" label="Подъём" on={has("wake")} value={has("wake") ? short(you.wake) : "7:00 — по умолчанию"} onClear={() => save({ wake: null })}>
          <div className="you-pick-own">
            <Pick label="Подъём" value={has("wake") ? you.wake : null} onPick={(w) => save({ wake: w })} options={WAKES} />
            <OwnTime label="Своё время подъёма, 4:00–11:59" value={has("wake") && !WAKES.some(([w]) => w === you.wake) ? you.wake : ""}
              min="04:00" max="11:59" onSave={(t) => save({ wake: t }, `Подъём — ${short(t)}.`)} />
          </div>
        </Row>
        <Row k="bed" icon="🌙" label="Отбой" on={has("bed")} value={has("bed") ? (you.bed === "auto" ? "узнаёт сама" : short(you.bed)) : "узнаёт сама — по умолчанию"} onClear={() => save({ bed: null })}>
          <div className="you-pick-own">
            <Pick label="Отбой" value={has("bed") ? you.bed : null} onPick={(b) => save({ bed: b })} options={BEDS} />
            <OwnTime label="Своё время отбоя, 18:00–3:59" value={has("bed") && !BEDS.some(([b]) => b === you.bed) ? you.bed : ""}
              onSave={(t) => save({ bed: t }, `Отбой — ${short(t)}.`)} />
          </div>
        </Row>
      </Card>

      <Card title="Тело и здоровье" className="reveal">
        <Row k="height" icon="📏" label="Рост" on={has("height")} value={has("height") ? `${you.height} см` : "не указан"} onClear={() => save({ height: null })}>
          <input className="you-height" inputMode="numeric" value={height} placeholder="см" aria-label="Рост, см"
            onChange={(e) => setHeight(e.target.value.replace(/\D/g, "").slice(0, 3))} onBlur={commitHeight} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        </Row>
        <div className="you-row ro">
          <div className="you-row-head">
            <span className="you-ic" aria-hidden="true">⚖️</span><span className="you-l">Вес</span>
            <span className="you-val you-v">{you.weight != null ? `${you.weight} кг · из записей` : "скажите Рине «вешу 72 кг»"}</span>
          </div>
        </div>
        <div className="you-row ro">
          <div className="you-row-head">
            <span className="you-ic" aria-hidden="true">🩹</span><span className="you-l">Здоровье и еда</span>
            <button type="button" className="you-val you-v link" onClick={() => navigate("/profile")}>{`дебафов ${you.traits.debuffs}, бафов ${you.traits.buffs} — в профиле`}</button>
          </div>
        </div>
      </Card>
    </div>
  );
}
