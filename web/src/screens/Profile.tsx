import { useEffect, useRef, useState } from "react";
import { get, post } from "../api";
import { Empty, Spinner } from "../components";
import { shortDay } from "../format";

// Профиль как лист персонажа в RPG (GET /api/profile): аватар, уровень вместо возраста — опыт за сделанные задачи,
// отмеченные привычки и дни с записями; характеристики из дневника здоровья; дебафы (аллергии, непереносимость…)
// и бафы — горничная учитывает их в ответах. «Горничная заметила» — закономерности из дневника: в дебафы — только после «Добавить».

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

/** Картинку — в квадрат 256 px (webp/jpeg), чтобы аватар был лёгким. */
async function squareImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error("не картинка"));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    c.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    const webp = c.toDataURL("image/webp", 0.86);
    return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function TraitTile({ t, onRemove }: { t: Trait; onRemove: () => void }) {
  const [icon, cat] = CATS[t.category] ?? CATS.other;
  const why = [SOURCE[t.source] ?? "", t.days.length ? `дни: ${t.days.map(shortDay).join(", ")}` : ""].filter(Boolean).join("; ");
  return (
    <li className={`trait ${t.kind}`} title={why}>
      <span className="trait-icon" aria-hidden="true">{icon}</span>
      <span className="grow">
        <b>{t.title}</b>
        <span className="muted small">{cat}{t.note ? ` — ${t.note}` : ""}</span>
      </span>
      <button className="ghost tiny" onClick={onRemove} title="Убрать из профиля" aria-label={`Убрать «${t.title}»`}>✕</button>
    </li>
  );
}

export function Profile({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [p, setP] = useState<ProfileData | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [editHeight, setEditHeight] = useState<string | null>(null);
  const [form, setForm] = useState({ kind: "debuff" as "debuff" | "buff", category: "allergy", title: "", note: "" });
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
    } catch (e) {
      setNote((e as Error).message);
    }
  }
  const save = (patch: Partial<Pick<ProfileData, "title" | "height" | "avatar">>) => run(() => post<ProfileData>("/api/profile", patch));
  const setStatus = (t: Trait, status: string) => run(() => post<{ text?: string; profile: ProfileData }>(`/api/traits/${t.id}`, { status }));

  if (error) return <Empty>Нет связи: {error}</Empty>;
  if (!p) return <Spinner />;

  const debuffs = p.traits.filter((t) => t.kind === "debuff");
  const buffs = p.traits.filter((t) => t.kind === "buff");
  const share = p.need ? p.into / p.need : 0;

  return (
    <div className="screen profile">
      <h2 className="screen-title">Профиль</h2>

      <section className="char-sheet">
        <button className="avatar-frame" onClick={() => file.current?.click()} title="Сменить аватар">
          {p.avatar ? <img src={p.avatar} alt="" /> : <span className="avatar-empty">{(p.name || "?").slice(0, 1).toUpperCase()}</span>}
          <span className="lvl-badge" aria-label={`Уровень ${p.level}`}><small>LVL</small>{p.level}</span>
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try { await save({ avatar: await squareImage(f) }); } catch (err) { setNote((err as Error).message); }
        }} />

        <div className="char-sheet-main">
          <div className="char-sheet-name">{p.name || "Хозяин"}</div>
          {editTitle === null ? (
            <button className="link char-sheet-title" onClick={() => setEditTitle(p.title)} title="Изменить класс">
              {p.title || "Выбрать класс…"}
            </button>
          ) : (
            <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); save({ title: editTitle }); setEditTitle(null); }}>
              <input autoFocus value={editTitle} maxLength={40} placeholder="Паладин порядка, бард дедлайнов…"
                onChange={(e) => setEditTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditTitle(null)} />
              <button className="primary">Сохранить</button>
            </form>
          )}
          <div className="xp" title="Опыт: задача — 10, привычка — 5, день с записями — 3">
            <div className="xp-bar"><span style={{ width: `${Math.round(share * 100)}%` }} /></div>
            <div className="xp-text"><b>{p.into}</b> / {p.need} опыта до {p.level + 1} уровня</div>
          </div>
          <div className="char-sheet-counts muted small">
            Задач сделано: {p.counts.tasks} · привычек отмечено: {p.counts.habits} · дней в дневнике: {p.counts.days}
          </div>
        </div>
      </section>

      {note && <p className="profile-note">{note}</p>}

      <h3 className="profile-head">Характеристики</h3>
      <div className="stats-grid">
        {p.stats.map((s) => (
          <div key={s.key} className="stat" title={s.hint}>
            <span className="stat-label">{s.label}</span>
            {s.key === "height" && editHeight !== null ? (
              <form onSubmit={(e) => { e.preventDefault(); save({ height: editHeight ? Number(editHeight) : null }); setEditHeight(null); }}>
                <input autoFocus inputMode="numeric" value={editHeight} placeholder="см" aria-label="Рост, см"
                  onChange={(e) => setEditHeight(e.target.value.replace(/\D/g, "").slice(0, 3))}
                  onBlur={() => setEditHeight(null)} onKeyDown={(e) => e.key === "Escape" && setEditHeight(null)} />
              </form>
            ) : s.key === "height" ? (
              <button className="stat-value link" onClick={() => setEditHeight(p.height ? String(p.height) : "")} title="Указать рост">{s.value}</button>
            ) : (
              <span className="stat-value">{s.value}</span>
            )}
          </div>
        ))}
      </div>

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

      <div className="traits-cols">
        <section>
          <h3 className="profile-head debuff">Дебафы <span className="muted small">{debuffs.length || ""}</span></h3>
          {debuffs.length ? <ul className="traits">{debuffs.map((t) => <TraitTile key={t.id} t={t} onRemove={() => setStatus(t, "removed")} />)}</ul>
            : <p className="muted small">Аллергии, непереносимость, что вредит. Горничная предупредит, если спросите о таком.</p>}
        </section>
        <section>
          <h3 className="profile-head buff">Бафы <span className="muted small">{buffs.length || ""}</span></h3>
          {buffs.length ? <ul className="traits">{buffs.map((t) => <TraitTile key={t.id} t={t} onRemove={() => setStatus(t, "removed")} />)}</ul>
            : <p className="muted small">Что помогает: «после прогулки лучше сплю», «кофе бодрит».</p>}
        </section>
      </div>

      <form className="trait-form" onSubmit={(e) => {
        e.preventDefault();
        if (!form.title.trim()) return;
        run(() => post<ProfileData>("/api/traits", form)).then(() => setForm((f) => ({ ...f, title: "", note: "" })));
      }}>
        <div className="seg" role="radiogroup" aria-label="Что добавить">
          <button type="button" role="radio" aria-checked={form.kind === "debuff"} className={form.kind === "debuff" ? "on debuff" : ""}
            onClick={() => setForm({ ...form, kind: "debuff" })}>Дебаф</button>
          <button type="button" role="radio" aria-checked={form.kind === "buff"} className={form.kind === "buff" ? "on buff" : ""}
            onClick={() => setForm({ ...form, kind: "buff" })}>Баф</button>
        </div>
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} aria-label="Вид">
          {Object.entries(CATS).map(([k, [icon, label]]) => <option key={k} value={k}>{icon} {label}</option>)}
        </select>
        <input value={form.title} maxLength={60} onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder={form.kind === "debuff" ? "Аллергия на арахис" : "Прогулка — сон лучше"} aria-label="Название" />
        <input value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Подробнее (необязательно)" aria-label="Подробнее" />
        <button className="primary" disabled={!form.title.trim()}>Добавить</button>
      </form>
    </div>
  );
}
