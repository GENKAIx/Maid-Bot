import { useEffect, useState } from "react";
import { promptError, promptIdOf, type PromptCardData, type PromptsData } from "../admin";
import { navigate } from "../router";
import { Loading } from "./AdminSections";
import { Note, Reason, useAct, useSection, type ActNote } from "./AdminManage";

// Промпты (27.11.2026): тексты, которые получает ИИ, — владелец правит их без выкладки (server/src/prompts.ts). Список по разделам
// без текстов (/admin/prompts) и карточка промпта (/admin/prompts/<id>): действующий текст, правка новой версией, предпросмотр
// целиком (со схемами, которые строит код), все версии и «как в коде» (v0) с выбором любой из них. Каждое действие — с причиной,
// сервер пишет его в журнал админа без текста. Текст промпта — второе исключение из правила «в админке без текстов»: это тексты
// владельца для ИИ, а не данные людей.

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const vText = (v: number) => (v > 0 ? `v${v}` : "как в коде");
/** Высота поля правки по тексту: короткий промпт — маленькое поле, длинный — не больше 18 строк. */
export const editRows = (t: string) => Math.min(18, Math.max(4, t.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 110)), 0) + 1));

/** Раздел «Промпты»: список или карточка — по адресу; «назад» в браузере возвращает к списку. */
export function AdminPrompts() {
  const [id, setId] = useState<string | null>(() => promptIdOf(window.location.pathname));
  useEffect(() => {
    const on = () => setId(promptIdOf(window.location.pathname));
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const open = (to: string | null) => navigate(to ? `/admin/prompts/${to}` : "/admin/prompts");
  return id ? <AdminPromptCard key={id} id={id} onBack={() => open(null)} /> : <AdminPromptList onOpen={open} />;
}

function AdminPromptList({ onOpen }: { onOpen: (id: string) => void }) {
  const s = useSection<PromptsData>("/api/admin/prompts");
  if (!s.data) return <Loading err={s.err} />;
  return <PromptsPage data={s.data} onOpen={onOpen} />;
}

function AdminPromptCard({ id, onBack }: { id: string; onBack: () => void }) {
  const s = useSection<PromptCardData>(`/api/admin/prompts/${id}`);
  if (!s.data) return <><BackLink onBack={onBack} /><Loading err={s.err} /></>;
  return <PromptCardPage key={s.tick} card={s.data} onBack={onBack} onChanged={s.onChanged} note={s.note} setNote={s.setNote} />;
}

const BackLink = ({ onBack }: { onBack: () => void }) => (
  <p><a className="adm-link" href="/admin/prompts" onClick={(e) => { e.preventDefault(); onBack(); }}>← Все промпты</a></p>
);

/** Список промптов по разделам: какая версия действует, сколько версий, когда и кем (#id) менялось. Текстов здесь нет. */
export function PromptsPage({ data, onOpen }: { data: PromptsData; onOpen: (id: string) => void }) {
  return (
    <div className="adm-al">
      <p className="adm-muted">
        Тексты, которые получает ИИ: разбор сообщений, ответы, утро и вечер, характеры, картинки. Каждая правка — новая версия, любую
        можно выбрать снова, «как в коде» — версия из программы. Сервер берёт правку сразу, другие копии сервера — в течение{" "}
        {Math.round(data.reload_ms / 1000)} с. Схемы ответа и перечни, которые строит код, здесь не правятся — они видны в предпросмотре.
      </p>
      {data.sections.map((sec) => (
        <section key={sec.title}>
          <h2 className="adm-h2">{sec.title}</h2>
          <div className="adm-panel adm-scroll">
            <table className="adm-table">
              <thead><tr><th>Промпт</th><th>Действует</th><th>Версий</th><th>Изменено</th><th /></tr></thead>
              <tbody>{sec.prompts.map((p) => (
                <tr key={p.id}>
                  <td>{p.title}<div className="adm-muted adm-small">{p.hint}</div><div className="adm-muted adm-small adm-num">{p.id}</div></td>
                  <td>
                    <span className={`adm-al-st ${p.version > 0 ? "ok" : ""}`}>{vText(p.version)}</span>
                    {p.version > 0 && !p.differs_from_default && <div className="adm-muted adm-small">совпадает с кодом</div>}
                    {p.broken && <div className="adm-err adm-small">записана v{p.stored_version}, не подходит к коду</div>}
                  </td>
                  <td className="adm-num">{p.versions}</td>
                  <td className="adm-num">{dt(p.changed_at)}{p.changed_by && <div className="adm-muted adm-small">{p.changed_by}</div>}</td>
                  <td>
                    <a className="adm-btn small" href={`/admin/prompts/${p.id}`} onClick={(e) => { e.preventDefault(); onOpen(p.id); }}>Открыть</a>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

/** Карточка промпта: описание, подстановки, действующий текст, правка новой версией, предпросмотр целиком, все версии и v0. */
export function PromptCardPage({ card, onBack, onChanged, note, setNote, editing: startEditing = false }: {
  card: PromptCardData; onBack: () => void; onChanged: () => void; note: ActNote; setNote: (n: ActNote) => void; editing?: boolean;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [text, setText] = useState(card.body);
  const [reason, setReason] = useState("");
  const { act, busy } = useAct(reason, setReason, setNote, onChanged);
  const err = editing ? promptError(card, text) : null;
  const same = text === card.body;
  const base = `/api/admin/prompts/${card.id}`;
  const save = () => {
    if (err || same) return setNote({ ok: false, text: err ?? "Текст тот же — менять нечего." });
    void act(`${base}/save`, { body: text }, () => `«${card.title}»: сохранено как новая версия, она уже действует.`);
  };
  const select = (v: number) => void act(`${base}/select`, { version: v }, () => `«${card.title}»: действует ${v > 0 ? `v${v}` : "текст как в коде (v0)"}.`);
  const versions = [...card.versions, { version: 0, body: card.def, created_at: "", created_by: "", reason: "" }];
  return (
    <div className="adm-al adm-pr">
      <BackLink onBack={onBack} />
      <section className="adm-panel adm-al-acts">
        <h2 className="adm-h2">{card.title} <span className="adm-muted adm-small adm-num">{card.id}</span></h2>
        <p className="adm-muted">{card.hint}</p>
        <p>Действует: <span className={`adm-al-st ${card.version > 0 ? "ok" : ""}`}>{card.version > 0 ? `v${card.version}` : "как в коде (v0)"}</span>
          <span className="adm-muted adm-small"> · {card.body.length} из {card.max} знаков</span></p>
        {card.broken && (
          <p className="adm-err" role="alert">
            Записана версия v{card.stored_version}, но она не подходит к нынешнему коду (в нём поменялись подстановки) — модель получает текст
            как в коде. Выберите «как в коде (v0)» или сохраните новую версию, иначе v{card.stored_version} снова начнёт действовать, если код вернут.
          </p>
        )}
        {card.vars.length > 0 && (
          <div className="adm-pr-vars">
            <span className="adm-muted adm-small">Подстановки — код ставит вместо них значения:</span>
            <ul>{card.vars.map((v) => (
              <li key={v}>
                <span className="adm-chip adm-num">{`{{${v}}}`}</span>{" "}
                {card.var_hints[v] && <span>{card.var_hints[v]}</span>}
                {card.required.includes(v) && <span className="adm-muted adm-small"> — обязательна</span>}
              </li>
            ))}</ul>
          </div>
        )}
        {card.must_contain.length > 0 && (
          <p className="adm-muted adm-small">Должно остаться в тексте (код на это опирается, без него сохранить нельзя): {card.must_contain.map((t) => `«${t}»`).join(", ")}.</p>
        )}
        {card.readonly && <p className="adm-muted adm-small">Только для чтения: {card.readonly}</p>}
      </section>

      <section className="adm-panel adm-al-acts">
        <h2 className="adm-h2">Текст сейчас</h2>
        {!editing ? (
          <>
            <pre className="adm-pr-text">{card.body}</pre>
            <div><button className="adm-btn primary" onClick={() => { setText(card.body); setEditing(true); }}>Изменить</button></div>
          </>
        ) : (
          <>
            <textarea className={`adm-tf-txt adm-pr-edit${err ? " err" : !same ? " ch" : ""}`} aria-label="Текст промпта" rows={editRows(text)} maxLength={card.max + 1000}
              value={text} onChange={(e) => setText(e.target.value)} />
            <span className={err ? "adm-err" : "adm-muted adm-small"} role={err ? "alert" : undefined}>
              {err ?? (same ? "Текст тот же, что действует." : `${text.length} из ${card.max} знаков.`)}
            </span>
            <Reason value={reason} onChange={setReason} />
            <div className="adm-toolbar">
              <button className="adm-btn primary" disabled={busy || Boolean(err) || same} onClick={save}>Сохранить как новую версию</button>
              <button className="adm-btn" disabled={busy} onClick={() => { setEditing(false); setText(card.body); }}>Отмена</button>
            </div>
          </>
        )}
        <Note note={note} />
      </section>

      <details className="adm-panel adm-notes-past">
        <summary>Предпросмотр целиком</summary>
        <p className="adm-muted adm-small">Так модель получит действующий текст: с примером подстановок и тем, что строит код вокруг него.</p>
        <pre className="adm-pr-text">{card.preview}</pre>
      </details>

      <section className="adm-panel adm-al-acts">
        <h2 className="adm-h2">Версии</h2>
        <p className="adm-muted adm-small">Новые сверху. Выбранная версия начинает действовать сразу; причина записывается в журнал админа.</p>
        {editing ? <p className="adm-muted adm-small">Пока открыта правка, версию не выбрать: сначала сохраните или отмените правку.</p>
          : <><Reason value={reason} onChange={setReason} />{note && !note.ok && <Note note={note} />}</>}
        <div className="adm-scroll">
          <table className="adm-table">
            <thead><tr><th>Версия</th><th>Когда</th><th>Кто</th><th>Причина</th><th>Текст</th><th /></tr></thead>
            <tbody>{versions.map((v) => {
              const on = v.version === card.version;
              // Выключена у записанной в базе (её номер — stored_version): при негодной записанной версии v0 выбрать можно.
              const stored = v.version === card.stored_version;
              return (
                <tr key={v.version}>
                  <td className="adm-num">{v.version > 0 ? `v${v.version}` : "как в коде (v0)"}{on && <div><span className="adm-al-st ok">действует</span></div>}</td>
                  <td className="adm-num">{v.created_at ? dt(v.created_at) : "—"}</td>
                  <td className="adm-num">{v.created_by || "—"}</td>
                  <td className="adm-al-text">{v.reason || <span className="adm-muted">{v.version > 0 ? "—" : "текст из программы"}</span>}</td>
                  <td>
                    <details className="adm-notes-past">
                      <summary>{v.body.length} знаков</summary>
                      <pre className="adm-pr-text">{v.body}</pre>
                    </details>
                  </td>
                  <td>
                    <button className="adm-btn small" disabled={busy || stored || editing} title={editing ? "Сначала сохраните или отмените правку" : undefined} onClick={() => select(v.version)}>Выбрать эту версию</button>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
