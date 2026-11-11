import { useEffect, useRef, useState } from "react";
import { get, post } from "../api";
import { Empty, Spinner } from "../components";
import { shortDay } from "../format";

// Профиль как окно персонажа в MMORPG (GET /api/profile): вертикальный портрет в рамке с уровнем, рядом плотный список
// характеристик; уровень вместо возраста — опыт за сделанные задачи, отмеченные привычки и дни с записями. Дебафы
// (аллергии, непереносимость…) и бафы — квадратные иконки, наведение показывает, что это; горничная учитывает их в ответах.
// «Горничная заметила» — закономерности из дневника: в дебафы — только после «Добавить».

type Trait = { id: number; kind: "debuff" | "buff"; category: string; title: string; note: string; source: string; status: string; days: string[]; created_at: string };
type Stat = { key: string; label: string; value: string; hint: string };
type ProfileData = {
  name: string; title: string; height: number | null; avatar: string;
  xp: number; level: number; into: number; need: number;
  counts: { tasks: number; habits: number; days: number }; days: number | null;
  stats: Stat[]; traits: Trait[]; suggested: Trait[];
};

const CATS: Record<string, [string, string]> = {
  allergy: ["🤧", "Аллергия"], food: ["🍽", "Еда"], med: ["💊", "Лекарства"], condition: ["🩺", "Здоровье"],
  body: ["🦴", "Тело"], habit: ["🔁", "Привычка"], other: ["✦", "Другое"],
};
const SOURCE: Record<string, string> = { user: "добавили сами", chat: "из разговора с горничной", pattern: "горничная заметила в дневнике" };

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

/** Дебаф или баф — квадратная иконка; наведение (или фокус) — подсказка: что это, откуда, «Убрать». */
function TraitIcon({ t, onRemove }: { t: Trait; onRemove: () => void }) {
  const [icon, cat] = CATS[t.category] ?? CATS.other;
  return (
    <li className={`aura ${t.kind}`}>
      <button className="aura-icon" aria-label={`${t.title}: ${cat}`}><span aria-hidden="true">{icon}</span></button>
      <div className="aura-tip" role="tooltip">
        <b>{t.title}</b>
        <span className="aura-kind">{t.kind === "buff" ? "Баф" : "Дебаф"}, {cat.toLowerCase()}</span>
        {t.note && <span>{t.note}</span>}
        <span className="aura-src">
          {SOURCE[t.source] ?? ""}{t.days.length ? `: ${t.days.map(shortDay).join(", ")}` : ""}
        </span>
        <button className="link" onClick={onRemove}>Убрать из профиля</button>
      </div>
    </li>
  );
}

function AuraRow({ kind, list, onAdd, onRemove }: { kind: "debuff" | "buff"; list: Trait[]; onAdd: () => void; onRemove: (t: Trait) => void }) {
  const label = kind === "buff" ? "Бафы" : "Дебафы";
  return (
    <div className="aura-row">
      <span className={`aura-label ${kind}`}>{label}</span>
      <ul>
        {list.map((t) => <TraitIcon key={t.id} t={t} onRemove={() => onRemove(t)} />)}
        <li><button className="aura-add" onClick={onAdd} title={kind === "buff" ? "Добавить баф — что помогает" : "Добавить дебаф — аллергия, непереносимость, что вредит"}
          aria-label={kind === "buff" ? "Добавить баф" : "Добавить дебаф"}>+</button></li>
      </ul>
    </div>
  );
}

export function Profile({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [p, setP] = useState<ProfileData | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [editHeight, setEditHeight] = useState<string | null>(null);
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
  const save = (patch: Partial<Pick<ProfileData, "title" | "height" | "avatar">>) => run(() => post<ProfileData>("/api/profile", patch));
  const setStatus = (t: Trait, status: string) => run(() => post<{ text?: string; profile: ProfileData }>(`/api/traits/${t.id}`, { status }));
  const toggleAdd = (kind: "debuff" | "buff") => setAdding((a) => (a === kind ? null : kind));

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!p) return <Spinner />;

  const debuffs = p.traits.filter((t) => t.kind === "debuff");
  const buffs = p.traits.filter((t) => t.kind === "buff");
  const share = p.need ? p.into / p.need : 0;

  return (
    <div className="screen profile">
      <h2 className="screen-title">Профиль</h2>

      <section className="char-sheet">
        <div className="portrait-col">
          <button className="portrait" onClick={() => file.current?.click()} title="Сменить портрет">
            {p.avatar ? <img src={p.avatar} alt="" /> : <span className="avatar-empty">{(p.name || "?").slice(0, 1).toUpperCase()}</span>}
            <span className="lvl-badge" aria-label={`Уровень ${p.level}`}><small>LVL</small>{p.level}</span>
          </button>
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

          <dl className="stat-list">
            {p.stats.map((s) => (
              <div key={s.key} className="stat-row" title={s.hint}>
                <dt>{s.label}</dt>
                <dd>
                  {s.key === "height" && editHeight !== null ? (
                    <form onSubmit={(e) => { e.preventDefault(); save({ height: editHeight ? Number(editHeight) : null }); setEditHeight(null); }}>
                      <input autoFocus inputMode="numeric" value={editHeight} placeholder="см" aria-label="Рост, см"
                        onChange={(e) => setEditHeight(e.target.value.replace(/\D/g, "").slice(0, 3))}
                        onBlur={() => setEditHeight(null)} onKeyDown={(e) => e.key === "Escape" && setEditHeight(null)} />
                    </form>
                  ) : s.key === "height" ? (
                    <button className="link" onClick={() => setEditHeight(p.height ? String(p.height) : "")} title="Указать рост">{s.value}</button>
                  ) : s.value}
                </dd>
              </div>
            ))}
            <div className="stat-row" title={`Задач сделано: ${p.counts.tasks}, привычек отмечено: ${p.counts.habits}, дней в дневнике: ${p.counts.days}`}>
              <dt>Задачи / привычки / дни</dt><dd>{p.counts.tasks} / {p.counts.habits} / {p.counts.days}</dd>
            </div>
          </dl>

          <div className="auras">
            <AuraRow kind="debuff" list={debuffs} onAdd={() => toggleAdd("debuff")} onRemove={(t) => setStatus(t, "removed")} />
            <AuraRow kind="buff" list={buffs} onAdd={() => toggleAdd("buff")} onRemove={(t) => setStatus(t, "removed")} />
          </div>
        </div>
      </section>

      {note && <p className="profile-note">{note}</p>}

      {adding && (
        <form className="trait-form" onSubmit={async (e) => {
          e.preventDefault();
          if (!form.title.trim()) return;
          if (await run(() => post<ProfileData>("/api/traits", { ...form, kind: adding }))) {
            setForm((f) => ({ ...f, title: "", note: "" }));
            setAdding(null);
          }
        }}>
          <b className={`aura-label ${adding}`}>{adding === "buff" ? "Новый баф" : "Новый дебаф"}</b>
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} aria-label="Вид">
            {Object.entries(CATS).map(([k, [icon, label]]) => <option key={k} value={k}>{icon} {label}</option>)}
          </select>
          <input autoFocus value={form.title} maxLength={60} onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder={adding === "debuff" ? "Аллергия на арахис" : "Прогулка — сон лучше"} aria-label="Название" />
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
