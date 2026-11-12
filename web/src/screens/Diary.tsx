import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { del, get } from "../api";
import { Card, Chip, Empty, Spinner } from "../components";
import { HEALTH_TOPICS, SECTIONS, SECTION_ORDER, WEEKDAYS, addDays, addMonths, dur, humanDay, metricText, money, monthGrid, monthTitle, todayKey } from "../format";
import { navigate } from "../router";
import { dayEmojis, emojiIcon, type DayEmoji, type Why } from "../dayEmoji";
import type { ActivityRow, DayData, DiaryRow, MetricRow } from "../types";
import { EventList } from "./Today";

// Дневник по дням: календарь с эмодзи дня (чем занимался — dayEmoji.ts), день — по разделам, показатели, деньги, компьютер.

/** Эмодзи картинкой (Emoji Kitchen), без картинки — символом. */
function Sticker({ emoji, style, data }: { emoji: string; style?: CSSProperties; data?: string }) {
  const src = emojiIcon(emoji);
  return src
    ? <img className="sticker" src={src} alt={emoji} draggable={false} style={style} data-emoji={data} />
    : <span className="sticker" style={style} data-emoji={data}>{emoji}</span>;
}

// Наклейки вразброс: у каждого дня свой разброс (от даты — не прыгает при обновлении). Первая — крупнее.
// Места [x, y, размер] в % клетки разнесены так, что наклейки не наезжают друг на друга и на число дня.
const SPOTS: [number, number, number][][] = [
  [[52, 56, 62]],
  [[34, 64, 46], [72, 36, 38]],
  [[32, 68, 42], [72, 34, 34], [74, 76, 30]],
];
function scatter(day: string, n: number) {
  let h = 2166136261;
  for (const c of day) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
  const flip = n > 1 && rnd() < 0.5; // крупная то слева, то справа
  return SPOTS[Math.min(n, 3) - 1].map(([x, y, s]) => ({
    x: (flip ? 100 - x : x) + (rnd() - 0.5) * 6,
    y: (flip && y < 50 ? y + 4 : y) + (rnd() - 0.5) * 6, // слева сверху — число дня
    s: s * (0.94 + rnd() * 0.1),
    r: (rnd() - 0.5) * 36,
  }));
}

/** Запись, на которую сработал эмодзи, — слово-причина выделено. */
function WhyLine({ why }: { why: Why }) {
  const i = why.hit ? why.text.indexOf(why.hit) : -1;
  if (i < 0) return <>{why.text}</>;
  return <>{why.text.slice(0, i)}<mark>{why.hit}</mark>{why.text.slice(i + why.hit!.length)}</>;
}

/** Сверху итога дня: эмодзи дня и что они значат; щелчок — почему он здесь. */
function DayStickers({ list, picked, onPick }: { list: DayEmoji[]; picked: string | null; onPick: (e: string | null) => void }) {
  const open = list.find((e) => e.emoji === picked);
  return (
    <div className="day-stickers">
      <div className="ds-row">
        {list.map((e) => (
          <button
            key={e.emoji}
            className={`ds-item ${e.emoji === picked ? "on" : ""}`}
            onClick={() => onPick(e.emoji === picked ? null : e.emoji)}
            aria-expanded={e.emoji === picked}
            title="Почему этот эмодзи"
          >
            <Sticker emoji={e.emoji} /><span>{e.what}</span>
          </button>
        ))}
      </div>
      {open && (
        <div className="ds-why">
          <span className="muted small">Почему {open.emoji} «{open.what}»:</span>
          <ul>{open.why.map((w, i) => <li key={i}><WhyLine why={w} /></li>)}</ul>
        </div>
      )}
    </div>
  );
}

export function Diary({ day, version, onChanged }: { day?: string; version: number; onChanged: () => void }) {
  const today = todayKey();
  const current = day ?? today;
  const [month, setMonth] = useState(current.slice(0, 7));
  const [days, setDays] = useState<Map<string, number>>(new Map());
  const [data, setData] = useState<DayData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => setMonth(current.slice(0, 7)), [current]);
  const [emojis, setEmojis] = useState<Map<string, DayEmoji[]>>(new Map());
  useEffect(() => {
    get<{ day: string; n: number }[]>("/api/diary/days").then((rows) => setDays(new Map(rows.map((r) => [r.day, r.n])))).catch(() => {});
  }, [version]);
  // Эмодзи дней месяца — по записям, играм и шагам (dayEmoji.ts).
  useEffect(() => {
    let alive = true;
    const from = `${month}-01`, to = `${month}-31`;
    Promise.all([
      get<DiaryRow[]>(`/api/diary?from=${from}&to=${to}`),
      get<ActivityRow[]>(`/api/activity?from=${from}&to=${to}`).catch(() => []),
      get<{ rows: MetricRow[] }>(`/api/metrics?from=${from}&to=${to}`).then((m) => m.rows).catch(() => []),
    ]).then(([d, a, m]) => alive && setEmojis(dayEmojis(d, a, m, 99))) // все — для итога дня; календарь берёт первые 3.catch(() => alive && setEmojis(new Map()));
    return () => { alive = false; };
  }, [month, version]);
  useEffect(() => {
    let alive = true;
    setData(null);
    get<DayData>(`/api/day?day=${current}`).then((d) => alive && setData(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [current, version]);

  const grid = useMemo(() => monthGrid(month), [month]);
  const top = useMemo(() => {
    const c = new Map<string, number>();
    for (const [d, list] of emojis) if (d.startsWith(month)) for (const e of list.slice(0, 3)) c.set(e.emoji, (c.get(e.emoji) ?? 0) + 1);
    return [...c.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [emojis, month]);
  const go = (d: string) => navigate(`/diary/${d}`);
  // Открытое пояснение эмодзи: день и эмодзи; на другом дне закрыто.
  const [pick, setPick] = useState<{ day: string; emoji: string } | null>(null);
  const picked = pick?.day === current ? pick.emoji : null;

  async function remove(id: number) {
    if (!confirm("Удалить эту запись?")) return;
    await del(`/api/diary/${id}`);
    onChanged();
  }

  const bySection = new Map<string, DayData["diary"]>();
  for (const r of data?.diary ?? []) bySection.set(r.section, [...(bySection.get(r.section) ?? []), r]);
  const sections = [...bySection.keys()].sort((a, b) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b));

  return (
    <div className="screen diary">
      <div className="diary-layout">
        <aside className="calendar reveal">
          <div className="cal-head">
            <button className="ghost" onClick={() => setMonth(addMonths(month, -1))} aria-label="Прошлый месяц">‹</button>
            <b>{monthTitle(month)}</b>
            <button className="ghost" onClick={() => setMonth(addMonths(month, 1))} aria-label="Следующий месяц">›</button>
          </div>
          <div className="cal-grid">
            {WEEKDAYS.map((w) => <span key={w} className="cal-wd">{w}</span>)}
            {grid.map((k, i) => {
              if (!k) return <span key={`e${i}`} />;
              const em = (emojis.get(k) ?? []).slice(0, 3);
              const n = days.get(k) ?? 0;
              const tip = em.length ? em.map((e) => `${e.emoji} ${e.what}`).join("\n") : n ? `записей: ${n}` : "";
              return (
                <button
                  key={k}
                  className={`cal-day ${k === current ? "on" : ""} ${k === today ? "today" : ""} ${k > today ? "future" : ""} ${em.length ? "has" : ""}`}
                  onClick={(ev) => {
                    // Щелчок по наклейке — открыть, почему она здесь.
                    const hit = (ev.target as HTMLElement).closest<HTMLElement>("[data-emoji]")?.dataset.emoji;
                    setPick(hit ? { day: k, emoji: hit } : null);
                    go(k);
                  }}
                  title={tip || undefined}
                >
                  <span className="cal-num">{Number(k.slice(-2))}</span>
                  {em.length > 0 ? (
                    <span className="cal-stickers">
                      {scatter(k, em.length).map((p, j) => (
                        <Sticker key={em[j].emoji} emoji={em[j].emoji} data={em[j].emoji} style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.s}%`, rotate: `${p.r}deg`, zIndex: 3 - j }} />
                      ))}
                    </span>
                  ) : n > 0 && <i className="dot" style={{ opacity: Math.min(1, 0.35 + n / 6) }} />}
                </button>
              );
            })}
          </div>
          <div className="cal-foot muted small">
            {top.length > 0 && <span className="cal-top" title="Чаще всего в этом месяце">{top.map(([e, c]) => <span key={e}><Sticker emoji={e} /><small>{c}</small></span>)}</span>}
            <span>Дней с записями: {days.size}</span>
          </div>
        </aside>

        <div className="diary-day">
          <div className="day-nav">
            <button className="ghost" onClick={() => go(addDays(current, -1))} aria-label="Вчера">‹</button>
            <h2 className="screen-title">{humanDay(current, current.slice(0, 4) !== today.slice(0, 4))}</h2>
            <button className="ghost" onClick={() => go(addDays(current, 1))} aria-label="Завтра">›</button>
            {current !== today && <button className="link" onClick={() => go(today)}>сегодня</button>}
          </div>

          {error && <Empty>Нет связи: {error}</Empty>}
          {!data && !error && <Spinner />}
          {data && (
            <div className="cards" key={current}>
              <Card className="reveal wide">
                {(emojis.get(current)?.length ?? 0) > 0 && <DayStickers list={emojis.get(current)!} picked={picked} onPick={(e) => setPick(e ? { day: current, emoji: e } : null)} />}
                {sections.length ? (
                  <div className="diary-sections">
                    {sections.map((s) => (
                      <div key={s} className="diary-section">
                        <b>{SECTIONS[s] ?? s}</b>
                        <ul>
                          {bySection.get(s)!.map((r) => (
                            <li key={r.id} className="entry">
                              <span className="grow">
                                {r.section === "health" && r.topic && <Chip tone="accent">{HEALTH_TOPICS[r.topic] ?? r.topic}</Chip>}
                                {r.text}
                              </span>
                              <button className="ghost tiny" onClick={() => remove(r.id)} title="Удалить" aria-label="Удалить">✕</button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : <Empty>{current > today ? "Этот день ещё не наступил" : "В этот день записей нет"}</Empty>}
              </Card>

              {(data.metrics.length > 0 || data.money.length > 0) && (
                <Card title="Показатели и деньги" className="reveal">
                  <div className="chips">
                    {data.metrics.map((m) => <Chip key={m.id}>{m.label}: <b>{metricText(m)}</b></Chip>)}
                    {data.money.map((m) => (
                      <Chip key={m.id} tone={m.kind === "income" ? "good" : "bad"}>
                        {m.kind === "income" ? "+" : "−"}{money(m.amount, m.currency)}{m.category ? ` · ${m.category}` : ""}
                      </Chip>
                    ))}
                  </div>
                </Card>
              )}

              {data.activity.length > 0 && (
                <Card title="Компьютер" className="reveal">
                  {data.activity.map((a) => (
                    <div key={a.source} className="activity">
                      {a.active_sec > 0 && <div>💻 {dur(a.active_sec)} за ПК <span className="muted small">{a.apps.slice(0, 5).map((x) => `${x.name} ${dur(x.sec)}`).join(", ")}</span></div>}
                      {a.games.length > 0 && <div>🎮 {dur(a.games.reduce((s, g) => s + g.sec, 0))} — {a.games.map((g) => `${g.name} ${dur(g.sec)}`).join(", ")}</div>}
                    </div>
                  ))}
                </Card>
              )}

              {data.events.length > 0 && (
                <Card title="Планы этого дня" className="reveal"><EventList events={data.events} /></Card>
              )}

              {data.habits.length > 0 && (
                <Card title="Привычки" className="reveal">
                  <ul className="list">
                    {data.habits.map((h) => (
                      <li key={h.id}>
                        <span className={`mark-dot ${h.status ?? "none"}`} />
                        <span className="grow">{h.title}</span>
                        {h.streak >= 2 && <Chip tone="fire">🔥 {h.streak}</Chip>}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
