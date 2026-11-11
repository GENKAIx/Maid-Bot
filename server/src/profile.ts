import type { MetricRow, Store, TraitRow, User } from "./db.ts";
import type { LlmCall } from "./llm.ts";
import { extractJson } from "./llm.ts";
import { addDays, humanDay } from "./time.ts";

// Профиль в духе карточки персонажа: уровень (опыт за сделанное), характеристики (рост — сам, вес, сон, шаги — из записей),
// дебафы и бафы. Активные дебафы горничная учитывает в ответах (traitPrompt → разбор, вопросы, разговор);
// закономерности из дневника она только предлагает (findPatterns → suggested), в дебафы — после «да» (decideTrait).

export const TRAIT_CATEGORIES: Record<string, string> = {
  allergy: "Аллергия", food: "Еда", med: "Лекарства", condition: "Здоровье", body: "Тело", habit: "Привычка", other: "Другое",
};
export const traitCategory = (c: unknown) => (typeof c === "string" && c in TRAIT_CATEGORIES ? c : "other");

/** Что пользователь заполняет сам: класс («Паладин»), рост в см, аватар (картинка data:… до AVATAR_MAX). */
export interface ProfileInfo { title: string; height: number | null; avatar: string }
export const AVATAR_MAX = 400_000;
const profileKey = (userId: number) => `profile:${userId}`;

export async function profileInfo(store: Store, userId: number): Promise<ProfileInfo> {
  try {
    const v = JSON.parse((await store.kvGet(profileKey(userId))) ?? "{}") as Partial<ProfileInfo>;
    return { title: typeof v.title === "string" ? v.title : "", height: typeof v.height === "number" ? v.height : null, avatar: typeof v.avatar === "string" ? v.avatar : "" };
  } catch {
    return { title: "", height: null, avatar: "" };
  }
}

export async function saveProfile(store: Store, userId: number, patch: Partial<ProfileInfo>): Promise<ProfileInfo> {
  const cur = await profileInfo(store, userId);
  if (patch.title !== undefined) cur.title = String(patch.title).trim().slice(0, 40);
  if (patch.height !== undefined) {
    const h = patch.height === null ? null : Number(patch.height);
    if (h !== null && !(h >= 50 && h <= 260)) throw new Error("рост — от 50 до 260 см");
    cur.height = h === null ? null : Math.round(h);
  }
  if (patch.avatar !== undefined) {
    const a = String(patch.avatar);
    if (a && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a)) throw new Error("аватар — картинка png, jpg, webp или gif");
    if (a.length > AVATAR_MAX) throw new Error("картинка слишком большая");
    cur.avatar = a;
  }
  await store.kvSet(profileKey(userId), JSON.stringify(cur));
  return cur;
}

/** Опыт: задача — 10, отмеченная привычка — 5, день с записями — 3. На следующий уровень нужно 100 + 25·(уровень − 1). */
export const XP = { task: 10, habit: 5, day: 3 };
export function levelOf(xp: number): { level: number; into: number; need: number } {
  let level = 1;
  let left = xp;
  while (left >= 100 + 25 * (level - 1)) {
    left -= 100 + 25 * (level - 1);
    level++;
  }
  return { level, into: left, need: 100 + 25 * (level - 1) };
}

export interface Stat { key: string; label: string; value: string; hint: string }

const avg = (rows: MetricRow[]) => (rows.length ? rows.reduce((a, r) => a + r.value, 0) / rows.length : null);
const num = (v: number, digits = 1) => v.toLocaleString("ru-RU", { maximumFractionDigits: digits });

export async function profileView(store: Store, u: User, today: string) {
  const info = await profileInfo(store, u.id);
  const counts = await store.xpCounts(u.id);
  const xp = counts.tasks * XP.task + counts.habits * XP.habit + counts.days * XP.day;
  const week = addDays(today, -6);
  const weights = await store.metricsRange(u.id, "2000-01-01", today, "weight");
  const weight = weights.at(-1);
  const sleep = avg(await store.metricsRange(u.id, week, today, "sleep_hours"));
  const steps = avg(await store.metricsRange(u.id, week, today, "steps"));
  const water = avg(await store.metricsRange(u.id, week, today, "water_l"));
  const since = (u as User & { created_at?: string }).created_at;
  const days = since ? Math.max(1, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(since)) / 86_400_000) + 1) : null;
  const stats: Stat[] = [
    { key: "height", label: "Рост", value: info.height ? `${info.height} см` : "—", hint: "Указываете сами" },
    { key: "weight", label: "Вес", value: weight ? `${num(weight.value)} кг` : "—", hint: weight ? `Последняя запись — ${humanDay(weight.day_key)}` : "Скажите горничной «вешу 72 кг»" },
    {
      key: "bmi", label: "ИМТ",
      value: weight && info.height ? num(weight.value / (info.height / 100) ** 2) : "—",
      hint: "Индекс массы тела: вес / рост² (ориентир 18,5–25)",
    },
    { key: "sleep", label: "Сон", value: sleep !== null ? `${num(sleep)} ч` : "—", hint: "В среднем за 7 дней" },
    { key: "steps", label: "Шаги", value: steps !== null ? num(steps, 0) : "—", hint: "В среднем за 7 дней" },
    { key: "water", label: "Вода", value: water !== null ? `${num(water)} л` : "—", hint: "В среднем за 7 дней" },
  ];
  const traits = await store.traitsOf(u.id);
  return {
    name: u.name, ...info, xp, ...levelOf(xp), counts, days, stats,
    traits: traits.filter((t) => t.status === "active").map(traitView),
    suggested: traits.filter((t) => t.status === "suggested").map(traitView),
  };
}

export function traitView(t: TraitRow) {
  let days: string[] = [];
  try { days = t.evidence ? (JSON.parse(t.evidence) as string[]) : []; } catch { days = []; }
  return { id: t.id, kind: t.kind, category: t.category, title: t.title, note: t.note, source: t.source, status: t.status, days, created_at: t.created_at };
}

/** Активные дебафы и бафы — в запрос модели. Пусто — пустая строка. */
export function traitPrompt(traits: TraitRow[]): string {
  const on = traits.filter((t) => t.status === "active");
  if (!on.length) return "";
  const line = (t: TraitRow) => `- [${TRAIT_CATEGORIES[t.category] ?? t.category}] ${t.title}${t.note ? ` — ${t.note}` : ""}`;
  const de = on.filter((t) => t.kind === "debuff").map(line);
  const bu = on.filter((t) => t.kind === "buff").map(line);
  return [
    de.length ? `Дебафы пользователя (аллергии, непереносимость, противопоказания):\n${de.join("\n")}` : "",
    bu.length ? `Бафы пользователя (что ему помогает):\n${bu.join("\n")}` : "",
    "Если сообщение или вопрос касается еды, напитков, лекарств, нагрузок или мест, которые задевают дебаф, — коротко и прямо " +
      "предупреди об этом в ответе (например: «Лучше без креветок — у вас на них аллергия»). Не к месту дебафы не упоминай.",
  ].filter(Boolean).join("\n");
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\d ]/gu, "").trim();
/** Уже есть такой (по названию, в любом статусе, кроме снятого) — не заводить второй. */
export const sameTrait = (traits: TraitRow[], title: string) => traits.find((t) => norm(t.title) === norm(title));

/** Сказал горничной («у меня аллергия на арахис») — сразу активный дебаф. Уже предложенный или отклонённый — становится активным. */
export async function addTraitFromChat(store: Store, userId: number, t: { kind: "debuff" | "buff"; category: string; title: string; note: string }, messageId: number) {
  const old = sameTrait(await store.traitsOf(userId), t.title);
  if (old?.status === "active") return null;
  if (old) {
    await store.updateTrait(old.id, { status: "active", note: t.note || old.note });
    return { id: old.id, before: { status: old.status, note: old.note } };
  }
  const id = await store.addTrait({ user_id: userId, kind: t.kind, category: traitCategory(t.category), title: t.title, note: t.note, source: "chat", status: "active", evidence: "", message_id: messageId });
  return { id, before: null };
}

/** Сколько дней назад смотреть дневник и сколько разных дней нужно, чтобы назвать это закономерностью. */
export const PATTERN_DAYS = 30;
export const PATTERN_MIN = 3;
/** Не больше стольких предложений за раз — чтобы не засыпать вопросами. */
const PATTERN_MAX = 2;

export interface Pattern { title: string; category: string; note: string; days: string[] }

/** Найти повторяющееся «от X плохо» в дневнике за PATTERN_DAYS и завести как предложения (suggested). Возвращает новые. */
export async function findPatterns(store: Store, llm: LlmCall, u: User, today: string): Promise<TraitRow[]> {
  const from = addDays(today, -PATTERN_DAYS);
  const rows = (await store.diaryRange(u.id, from, today)).filter((r) => ["health", "food", "mood", "sleep"].includes(r.section));
  const healthDays = new Set(rows.filter((r) => r.section === "health").map((r) => r.day_key));
  if (healthDays.size < PATTERN_MIN) return [];
  const traits = await store.traitsOf(u.id);
  const known = traits.map((t) => `- ${t.title}${t.status === "declined" ? " (пользователь отказался — не предлагать)" : ""}`).join("\n") || "нет";
  const log = rows.map((r) => `${r.day_key} [${r.section}${r.topic ? "/" + r.topic : ""}] ${r.text}`).join("\n");
  let raw: string;
  try {
    raw = await llm([
      {
        role: "system",
        content:
          "Ты смотришь дневник пользователя и ищешь повторяющиеся связи «после X ему плохо» (еда, напитки, лекарства, " +
          "недосып, нагрузка → боль, тошнота, сыпь, слабость и т. п.). Связь засчитывается, только если в дневнике она видна " +
          `минимум в ${PATTERN_MIN} разных днях: в один день — и X, и плохое самочувствие после него. Не выдумывай, не ставь ` +
          "диагнозов, случайные совпадения не бери. Уже известное ниже не повторяй.\n" +
          'Ответь JSON: {"patterns": [{"title": "коротко, до 40 символов: «Плохо после молока»", "category": "food|allergy|med|condition|body|other", ' +
          '"note": "одно предложение: что именно повторяется", "days": ["ГГГГ-ММ-ДД", …]}]}. Ничего не нашлось — {"patterns": []}.\n\n' +
          `Уже известно:\n${known}`,
      },
      { role: "user", content: log },
    ], { json: true, temperature: 0.2 });
  } catch (e) {
    console.error("[patterns]", u.id, e);
    return [];
  }
  let list: unknown[] = [];
  try {
    const j = extractJson(raw) as { patterns?: unknown };
    list = Array.isArray(j.patterns) ? j.patterns : [];
  } catch {
    return [];
  }
  const allDays = new Set(rows.map((r) => r.day_key));
  const out: TraitRow[] = [];
  for (const x of list) {
    if (out.length >= PATTERN_MAX) break;
    const p = x as Partial<Pattern>;
    const title = typeof p.title === "string" ? p.title.trim().slice(0, 60) : "";
    const days = [...new Set(Array.isArray(p.days) ? p.days.filter((d): d is string => typeof d === "string" && allDays.has(d)) : [])].sort();
    if (!title || days.length < PATTERN_MIN || sameTrait(traits, title)) continue;
    const id = await store.addTrait({
      user_id: u.id, kind: "debuff", category: traitCategory(p.category), title, note: typeof p.note === "string" ? p.note.trim().slice(0, 200) : "",
      source: "pattern", status: "suggested", evidence: JSON.stringify(days), message_id: null,
    });
    const row = (await store.trait(id))!;
    traits.push(row);
    out.push(row);
  }
  return out;
}

/** Текст уведомления о найденной закономерности. */
export function patternText(t: TraitRow, esc: (s: string) => string): string {
  const days = traitView(t).days;
  return `🔍 Заметила закономерность: <b>${esc(t.title)}</b>${t.note ? ` — ${esc(t.note)}` : ""}\n` +
    `${days.length} ${days.length % 10 >= 2 && days.length % 10 <= 4 && (days.length % 100 < 10 || days.length % 100 >= 20) ? "раза" : "раз"}: ${days.map((d) => humanDay(d).split(",")[0]).join(", ")}.\nДобавить в дебафы профиля?`;
}
export const traitButtons = (id: number) => [
  { text: "✅ Добавить", data: `trait:${id}:yes` },
  { text: "✖ Не надо", data: `trait:${id}:no` },
];

/** Ответ на предложение: yes — в дебафы, no — больше не предлагать. */
export async function decideTrait(store: Store, u: User, id: number, yes: boolean): Promise<string> {
  const t = await store.trait(id);
  if (!t || t.user_id !== u.id) return "Не нашла это.";
  if (t.status !== "suggested") return t.status === "active" ? "Уже в дебафах." : "Уже решили.";
  await store.updateTrait(id, { status: yes ? "active" : "declined" });
  return yes ? `Добавила в дебафы: «${t.title}». Буду учитывать.` : "Хорошо, не добавляю и больше не предложу.";
}
