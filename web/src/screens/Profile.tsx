import { useEffect, useRef, useState } from "react";
import { get, post } from "../api";
import { Empty, Spinner } from "../components";
import { shortDay } from "../format";
import { AuraGlyph, Mannequin, StatGlyph, auraIcon } from "./ProfileArt";

// Профиль как окно персонажа в MMORPG (GET /api/profile): слева портрет в золотой рамке (или манекен) со знаком уровня и
// опытом, в середине имя и характеристики плашками со значками, справа за чертой — дебафы и бафы сеткой квадратных значков
// эффектов; наведение показывает, что это. Уровень вместо возраста в игре — опыт за сделанные задачи, отмеченные привычки и
// дни с записями; настоящий возраст — из даты рождения. «Горничная заметила» — закономерности из дневника: в дебафы — только после «Добавить».

type Trait = { id: number; kind: "debuff" | "buff"; category: string; title: string; note: string; source: string; status: string; days: string[]; created_at: string };
type Stat = { key: string; label: string; value: string; hint: string };
type ProfileData = {
  name: string; title: string; height: number | null; birthday: string; avatar: string;
  xp: number; level: number; into: number; need: number;
  counts: { tasks: number; habits: number; days: number }; days: number | null;
  stats: Stat[]; traits: Trait[]; suggested: Trait[];
};

const CATS: Record<string, string> = {
  allergy: "Аллергия", food: "Еда", med: "Лекарства", condition: "Здоровье", body: "Тело", habit: "Привычка", other: "Другое",
};
const SOURCE: Record<string, string> = { user: "Добавили сами", chat: "Из разговора с горничной", pattern: "Горничная заметила в дневнике" };
// Эти строки видны всегда (их заполняют руками или они главные), остальные — только когда есть данные.
const ALWAYS = new Set(["age", "height", "weight"]);

/** Картинку — в портрет 240×320 (webp/jpeg), чтобы аватар был лёгким. Кадр — середина, чуть выше центра (там обычно лицо). */
async function portraitImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error("не картинка"));
      i.src = url;
    });
    const w = Math.min(img.naturalWidth, img.naturalHeight * 0.75), h = w / 0.75;
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 320;
    c.getContext("2d")!.drawImage(img, (img.naturalWidth - w) / 2, Math.max(0, (img.naturalHeight - h) * 0.35), w, h, 0, 0, 240, 320);
    const webp = c.toDataURL("image/webp", 0.86);
    return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Дебаф или баф — квадратный значок эффекта; наведение (или фокус) — подсказка: что это, откуда, «Убрать». */
function Aura({ t, onRemove }: { t: Trait; onRemove: () => void }) {
  return (
    <li className={`aura ${t.kind}`}>
      <button className="aura-icon" aria-label={t.title}><AuraGlyph name={auraIcon(t.kind, t.category, `${t.title} ${t.note}`)} /></button>
      <div className="aura-tip" role="tooltip">
        <b>{t.title}</b>
        <span className="aura-kind">{t.kind === "buff" ? "Баф" : "Дебаф"} · {CATS[t.category] ?? CATS.other}</span>
        {t.note && <span>{t.note}</span>}
        <span className="aura-src">{SOURCE[t.source] ?? ""}{t.days.length ? `: ${t.days.map(shortDay).join(", ")}` : ""}</span>
        <button className="link" onClick={onRemove}>Убрать из профиля</button>
      </div>
    </li>
  );
}

function AuraGrid({ kind, list, open, onAdd, onRemove }: {
  kind: "debuff" | "buff"; list: Trait[]; open: boolean; onAdd: () => void; onRemove: (t: Trait) => void;
}) {
  const buff = kind === "buff";
  return (
    <div className={`aura-group ${kind}`}>
      <div className="aura-head">{buff ? "Бафы" : "Дебафы"}{list.length > 0 && <span>{list.length}</span>}</div>
      <ul className="aura-grid">
        {list.map((t) => <Aura key={t.id} t={t} onRemove={() => onRemove(t)} />)}
        <li>
          <button className={`aura-add${open ? " on" : ""}`} onClick={onAdd} aria-label={buff ? "Добавить баф" : "Добавить дебаф"}
            title={buff ? "Добавить баф — что помогает" : "Добавить дебаф — аллергия, непереносимость, что вредит"}>+</button>
        </li>
      </ul>
      {list.length === 0 && (
        <p className="aura-empty">{buff ? "Что помогает: «после прогулки лучше сплю», «кофе бодрит»." : "Аллергии, непереносимость, что вредит — горничная учтёт в ответах."}</p>
      )}
    </div>
  );
}

export function Profile({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [p, setP] = useState<ProfileData | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ key: string; value: string } | null>(null);
  const [adding, setAdding] = useState<"debuff" | "buff" | null>(null);
  const [form, setForm] = useState({ category: "allergy", title: "", note: "" });
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    get<ProfileData>("/api/profile").then((r) => alive && setP(r)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [version]);

  async function run(fn: () => Promise<ProfileData | { text?: string; profile: ProfileData }>) {
    try {
      const r = await fn();
      if ("profile" in r) { setP(r.profile); setNote(r.text ?? ""); } else { setP(r); setNote(""); }
      onChanged();
      return true;
    } catch (e) {
      setNote((e as Error).message);
      return false;
    }
  }
  const save = (patch: Partial<Pick<ProfileData, "title" | "height" | "birthday" | "avatar">>) => run(() => post<ProfileData>("/api/profile", patch));
  const setStatus = (t: Trait, status: string) => run(() => post<{ text?: string; profile: ProfileData }>(`/api/traits/${t.id}`, { status }));
  const toggleAdd = (kind: "debuff" | "buff") => setAdding((a) => (a === kind ? null : kind));
  function saveEdit() {
    if (!edit) return;
    if (edit.key === "height") save({ height: edit.value ? Number(edit.value) : null });
    else save({ birthday: edit.value });
    setEdit(null);
  }

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!p) return <Spinner />;

  const debuffs = p.traits.filter((t) => t.kind === "debuff");
  const buffs = p.traits.filter((t) => t.kind === "buff");
  const share = p.need ? p.into / p.need : 0;
  const stats = p.stats.filter((s) => ALWAYS.has(s.key) || s.value !== "—");
  const editable = (k: string) => k === "height" || k === "age";

  return (
    <div className="screen profile">
      <h2 className="screen-title">Профиль</h2>

      <section className="char-sheet">
        <div className="portrait-col">
          <div className="portrait-wrap">
            <button className="portrait" onClick={() => file.current?.click()} title={p.avatar ? "Сменить портрет" : "Загрузить портрет"}>
              {p.avatar ? <img src={p.avatar} alt="" /> : <Mannequin />}
            </button>
            <span className="lvl-badge" aria-label={`Уровень ${p.level}`}><small>LVL</small>{p.level}</span>
          </div>
          <input ref={file} type="file" accept="image/*" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try { await save({ avatar: await portraitImage(f) }); } catch (err) { setNote((err as Error).message); }
          }} />
          <div className="xp" title={`Опыт: задача — 10, привычка — 5, день с записями — 3. Всего ${p.xp}`}>
            <div className="xp-bar"><span style={{ width: `${Math.round(share * 100)}%` }} /></div>
            <div className="xp-text"><b>{p.into}</b> / {p.need} до {p.level + 1} ур.</div>
          </div>
        </div>

        <div className="char-sheet-main">
          <div className="char-sheet-name">{p.name || "Хозяин"}</div>
          {editTitle === null ? (
            <button className="link char-sheet-title" onClick={() => setEditTitle(p.title)} title="Изменить класс">
              {p.title || "Выбрать класс…"}
            </button>
          ) : (
            <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); save({ title: editTitle }); setEditTitle(null); }}>
              <input autoFocus value={editTitle} maxLength={40} placeholder="Паладин порядка, бард дедлайнов…" aria-label="Класс"
                onChange={(e) => setEditTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditTitle(null)} />
              <button className="primary">Сохранить</button>
            </form>
          )}

          <ul className="stat-pills">
            {stats.map((s) => (
              <li key={s.key} className="stat-pill" title={s.hint}>
                <StatGlyph name={s.key} />
                <span className="stat-name">{s.label}</span>
                {edit?.key === s.key ? (
                  <form className="stat-edit" onSubmit={(e) => { e.preventDefault(); saveEdit(); }}>
                    {s.key === "age" ? (
                      <input autoFocus type="date" value={edit.value} max={new Date().toISOString().slice(0, 10)} min="1900-01-01" aria-label="Дата рождения"
                        onChange={(e) => setEdit({ key: "age", value: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setEdit(null)} />
                    ) : (
                      <input autoFocus inputMode="numeric" value={edit.value} placeholder="см" aria-label="Рост, см"
                        onChange={(e) => setEdit({ key: "height", value: e.target.value.replace(/\D/g, "").slice(0, 3) })}
                        onKeyDown={(e) => e.key === "Escape" && setEdit(null)} />
                    )}
                    <button className="primary tiny">ОК</button>
                  </form>
                ) : editable(s.key) ? (
                  <button className="stat-val link" onClick={() => setEdit({ key: s.key, value: s.key === "age" ? p.birthday : p.height ? String(p.height) : "" })}
                    title={s.key === "age" ? "Указать дату рождения" : "Указать рост"}>{s.value}</button>
                ) : <span className="stat-val">{s.value}</span>}
              </li>
            ))}
            <li className="stat-pill" title={`Задач сделано: ${p.counts.tasks}, привычек отмечено: ${p.counts.habits}, дней в дневнике: ${p.counts.days}`}>
              <StatGlyph name="deeds" />
              <span className="stat-name">Подвиги</span>
              <span className="stat-val">{p.counts.tasks + p.counts.habits}</span>
            </li>
          </ul>
        </div>

        <div className="char-sheet-auras">
          <AuraGrid kind="debuff" list={debuffs} open={adding === "debuff"} onAdd={() => toggleAdd("debuff")} onRemove={(t) => setStatus(t, "removed")} />
          <AuraGrid kind="buff" list={buffs} open={adding === "buff"} onAdd={() => toggleAdd("buff")} onRemove={(t) => setStatus(t, "removed")} />
        </div>
      </section>

      {note && <p className="profile-note">{note}</p>}

      {adding && (
        <form className={`trait-form ${adding}`} onSubmit={async (e) => {
          e.preventDefault();
          if (!form.title.trim()) return;
          if (await run(() => post<ProfileData>("/api/traits", { ...form, kind: adding }))) {
            setForm((f) => ({ ...f, title: "", note: "" }));
            setAdding(null);
          }
        }}>
          <span className="trait-form-icon aura-icon"><AuraGlyph name={auraIcon(adding, form.category, `${form.title} ${form.note}`)} /></span>
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} aria-label="Вид">
            {Object.entries(CATS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <input autoFocus value={form.title} maxLength={60} onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder={adding === "debuff" ? "Новый дебаф: аллергия на арахис" : "Новый баф: прогулка — сон лучше"} aria-label="Название" />
          <input value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Подробнее (необязательно)" aria-label="Подробнее" />
          <button className="primary" disabled={!form.title.trim()}>Добавить</button>
          <button type="button" className="ghost" onClick={() => setAdding(null)}>Отмена</button>
        </form>
      )}

      {p.suggested.length > 0 && (
        <section className="noticed">
          <h3 className="profile-head">Горничная заметила</h3>
          <ul>
            {p.suggested.map((t) => (
              <li key={t.id}>
                <span className="aura debuff"><span className="aura-icon"><AuraGlyph name={auraIcon("debuff", t.category, `${t.title} ${t.note}`)} /></span></span>
                <span className="grow">
                  <b>{t.title}</b>
                  {t.note && <span className="small"> — {t.note}</span>}
                  {t.days.length > 0 && <span className="muted small note">Повторялось {t.days.length} раз: {t.days.map(shortDay).join(", ")}</span>}
                </span>
                <button className="primary" onClick={() => setStatus(t, "active")}>Добавить в дебафы</button>
                <button className="ghost" onClick={() => setStatus(t, "declined")}>Не надо</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
