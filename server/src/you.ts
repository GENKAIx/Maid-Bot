import { config } from "./config.ts";
import type { Store, User } from "./db.ts";
import { profileInfo, saveProfile, type ProfileInfo } from "./profile.ts";
import { dayKey } from "./time.ts";

// «Персонализация → О вас» (20.11.2026): что горничной знать о человеке — обращение, город (с часовым поясом), подъём, отбой;
// день рождения и рост — из профиля (profile.ts), здесь они только правятся. Каждое поле что-то включает, ни одно не обязательно.
// Город ищется геокодером Open-Meteo (без ключа): название — нашему серверу, координаты — потом сервису погоды.

/** Как обращаться: «хозяин» (как было всегда), «хозяйка», по имени (users.name). */
export const ADDRESSES = ["master", "mistress", "name"] as const;
export type Address = (typeof ADDRESSES)[number];
/** Подъём — час, с которого у горничной утро (виджет на ПК: конец ночи); те же варианты, что были в настройке виджета, шире. */
export const WAKES = [5, 6, 7, 8, 9, 10] as const;
/** Отбой: «auto» — виджет узнаёт сам (когда вечером человек надолго уходит от ПК), иначе час, с которого ночь. */
export const BEDS = ["auto", "21:00", "22:00", "23:00", "00:00", "01:00", "02:00"] as const;

/** Выбранный город: название, регион и страна (чтобы не спутать Кировск и Киров), координаты, часовой пояс города. */
export interface City { name: string; region: string; country: string; lat: number; lon: number; tz: string }

/** Город из users.city (JSON); пусто или битое — нет города. */
export function cityOf(u: Pick<User, "city">): City | null {
  if (!u.city) return null;
  try {
    const c = JSON.parse(u.city) as Partial<City>;
    return typeof c.name === "string" && typeof c.lat === "number" && typeof c.lon === "number" && typeof c.tz === "string"
      ? { name: c.name, region: c.region ?? "", country: c.country ?? "", lat: c.lat, lon: c.lon, tz: c.tz } : null;
  } catch {
    return null;
  }
}

/** Поля «О вас» в порядке «Дальше: …» на сайте; всего их 7 — полоса «Заполнено N из 7». */
export const YOU_FIELDS = ["city", "wake", "address", "bed", "birthday", "height", "tz"] as const;
export type YouField = (typeof YOU_FIELDS)[number];

/** users.ask (JSON): set — что человек указал сам (у подъёма, обращения и пояса есть значения по умолчанию, по ним не понять);
 *  off — о чём Рина больше не спрашивает («Не скажу»); last — когда спрашивала (ISO). */
export interface AskState { set: string[]; off: string[]; last: string }
export function askOf(u: Pick<User, "ask">): AskState {
  try {
    const a = JSON.parse(u.ask || "{}") as Partial<AskState>;
    return { set: Array.isArray(a.set) ? a.set.filter((x) => typeof x === "string") : [], off: Array.isArray(a.off) ? a.off.filter((x) => typeof x === "string") : [], last: typeof a.last === "string" ? a.last : "" };
  } catch {
    return { set: [], off: [], last: "" };
  }
}

export const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
};

/** «UTC+5», «UTC+3», «UTC−3:30» — смещение пояса на эту дату. */
export function tzOffset(tz: string, at = new Date()): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = part.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return "UTC+0";
  const h = Number(m[2]), min = m[3];
  return `UTC${m[1] === "-" ? "−" : "+"}${h}${min === "00" ? "" : `:${min}`}`;
}

/** Слово обращения: «хозяин», «хозяйка» или имя (имени нет — «хозяин», как раньше). */
export function addressWord(u: Partial<Pick<User, "address" | "name">> | undefined): string {
  if (u?.address === "mistress") return "хозяйка";
  if (u?.address === "name" && u.name?.trim()) return u.name.trim();
  return "хозяин";
}

/** Готовые фразы с обращением «хозяин» — под выбранное: «Хозяин, вот ваши планы» → «Андрей, вот ваши планы». Только слово целиком
 *  в именительном (как обращение); заглавная остаётся заглавной. «Хозяин» по умолчанию — текст как был. */
export function callAs(text: string, u: Partial<Pick<User, "address" | "name">> | undefined): string {
  const w = addressWord(u);
  if (w === "хозяин") return text;
  return text.replace(/(^|[^А-Яа-яЁё])([Хх])озяин(?![А-Яа-яЁё])/g, (_, pre: string, h: string) =>
    pre + (h === "Х" ? w[0].toUpperCase() + w.slice(1) : w));
}

/** Строка в промпт: как обращаться к человеку. «Хозяин» — пусто (промпты и так так говорят). */
export function addressRule(u: Partial<Pick<User, "address" | "name">> | undefined): string {
  const w = addressWord(u);
  if (w === "хозяин") return "";
  if (u?.address === "mistress") return "Человек — женщина: обращаешься к ней «хозяйка» и говоришь о ней в женском роде.";
  return `Обращаешься к человеку по имени — «${w}» (вместо слова «хозяин»).`;
}

/** Поиск города по началу названия: геокодер Open-Meteo, по-русски, до 6 вариантов. fetcher — для тестов. */
export async function findCities(q: string, fetcher: typeof fetch = fetch): Promise<City[]> {
  const name = q.trim();
  if (name.length < 2) return [];
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=ru&format=json`;
  const res = await fetcher(url, { signal: AbortSignal.timeout(6_000) });
  if (!res.ok) throw new Error("поиск городов не отвечает");
  const j = (await res.json()) as { results?: { name?: string; admin1?: string; country?: string; latitude?: number; longitude?: number; timezone?: string }[] };
  return (j.results ?? [])
    .filter((r) => r.name && typeof r.latitude === "number" && typeof r.longitude === "number" && r.timezone && isTimeZone(r.timezone))
    .map((r) => ({ name: r.name!, region: r.admin1 ?? "", country: r.country ?? "", lat: r.latitude!, lon: r.longitude!, tz: r.timezone! }));
}

/** Что показывает «О вас»: свои поля, день рождения и рост из профиля, вес и дебафы — только для показа. */
export async function youView(store: Store, u: User, now = new Date()) {
  const info: ProfileInfo = await profileInfo(store, u.id);
  const weight = (await store.metricsRange(u.id, "2000-01-01", dayKey(now, u.tz), "weight")).at(-1);
  const traits = (await store.traitsOf(u.id)).filter((t) => t.status === "active");
  const city = cityOf(u);
  const set = askOf(u).set;
  const filled: Record<YouField, boolean> = {
    city: Boolean(city), wake: set.includes("wake"), address: set.includes("address"), bed: set.includes("bed") || u.bed !== "auto",
    birthday: Boolean(info.birthday), height: info.height != null, tz: set.includes("tz") || u.tz !== config.defaultTimezone,
  };
  return {
    name: u.name, address: u.address as Address, call: addressWord(u),
    city, tz: u.tz, tz_offset: tzOffset(u.tz, now), tz_default: config.defaultTimezone, tz_from_city: Boolean(city && city.tz === u.tz),
    wake: u.wake, bed: u.bed, birthday: info.birthday, height: info.height,
    weight: weight ? weight.value : null,
    filled: YOU_FIELDS.filter((k) => filled[k]),
    traits: { debuffs: traits.filter((t) => t.kind === "debuff").length, buffs: traits.filter((t) => t.kind === "buff").length },
  };
}

/** null у обращения, подъёма, отбоя и пояса — «стереть»: снова как по умолчанию. */
export interface YouPatch {
  address?: Address | null; name?: string;
  /** Новый город (из findCities) или null — стереть. Часовой пояс города ставится сам, если пояс не задан тем же запросом. */
  city?: City | null;
  tz?: string | null;
  wake?: number | null; bed?: string | null;
  birthday?: string; height?: number | null;
}

/** Записать «О вас». Возвращает, сменился ли часовой пояс (тогда напоминания о планах перекладываются заново). */
export async function saveYou(store: Store, u: User, p: YouPatch): Promise<{ tzChanged: boolean }> {
  const patch: Partial<User> = {};
  const ask = askOf(u);
  const mark = (k: YouField, on: boolean) => { ask.set = ask.set.filter((x) => x !== k); if (on) ask.set.push(k); };
  if (p.address !== undefined) { patch.address = p.address ?? "master"; mark("address", p.address !== null); }
  if (p.name !== undefined) patch.name = p.name.trim().slice(0, 80);
  if (p.address === "name" && !(p.name ?? u.name).trim()) throw new Error("для обращения по имени нужно имя");
  let tz = u.tz;
  if (p.city !== undefined) {
    const old = cityOf(u);
    if (p.city) {
      if (!isTimeZone(p.city.tz)) throw new Error("у города странный часовой пояс");
      patch.city = JSON.stringify({ name: p.city.name.slice(0, 80), region: p.city.region.slice(0, 80), country: p.city.country.slice(0, 60), lat: p.city.lat, lon: p.city.lon, tz: p.city.tz });
      // Пояс — от города, если человек не ставил свой (пояс прежнего города или по умолчанию).
      if (p.tz === undefined && (u.tz === config.defaultTimezone || (old && old.tz === u.tz))) tz = p.city.tz;
    } else {
      patch.city = "";
      // Стёрли город — пояс, взятый от него, уходит вместе с ним.
      if (p.tz === undefined && old && old.tz === u.tz) tz = config.defaultTimezone;
    }
  }
  if (p.tz !== undefined) {
    const t = p.tz ?? config.defaultTimezone;
    if (!isTimeZone(t)) throw new Error("нет такого часового пояса");
    tz = t;
    mark("tz", p.tz !== null);
  }
  if (tz !== u.tz) patch.tz = tz;
  if (p.wake !== undefined) {
    if (p.wake !== null && !(WAKES as readonly number[]).includes(p.wake)) throw new Error(`подъём — с ${WAKES[0]}:00 до ${WAKES[WAKES.length - 1]}:00`);
    patch.wake = p.wake ?? 7;
    mark("wake", p.wake !== null);
  }
  if (p.bed !== undefined) {
    if (p.bed !== null && !(BEDS as readonly string[]).includes(p.bed)) throw new Error("нет такого времени отбоя");
    patch.bed = p.bed ?? "auto";
    mark("bed", p.bed !== null);
  }
  const askText = JSON.stringify(ask);
  if (askText !== JSON.stringify(askOf(u))) patch.ask = askText;
  if (p.birthday !== undefined || p.height !== undefined) {
    const prof: Partial<ProfileInfo> = {};
    if (p.birthday !== undefined) prof.birthday = p.birthday;
    if (p.height !== undefined) prof.height = p.height;
    await saveProfile(store, u.id, prof);
  }
  if (Object.keys(patch).length) await store.updateUser(u.id, patch);
  return { tzChanged: tz !== u.tz };
}

// --- Рина спрашивает сама (20.11.2026) ---
// В облачке виджета: по одному вопросу, не чаще раза в 3 дня, только город → подъём → обращение; «Не скажу» — этот вопрос
// больше никогда (ask.off). Показ отмечает виджет (POST /api/you/ask) — даже без ответа следующий вопрос через 3 дня.
// В разговоре: человек сам назвал город или час подъёма — отдельным сообщением «Записать в профиль?» с кнопками (aboutOffer);
// что предложено, лежит в kv `youoffer:<id>` до ответа.

export const ASK_ORDER = ["city", "wake", "address"] as const;
export const ASK_EVERY_MS = 3 * 86_400_000;
export interface YouButton { text: string; data: string }
export interface AskCard { field: (typeof ASK_ORDER)[number]; text: string; buttons: YouButton[] }

/** Следующий вопрос облачка или null: рано (меньше 3 дней с прошлого), всё указано или на всё «Не скажу». */
export function askNext(u: User, now = new Date()): AskCard | null {
  const a = askOf(u);
  if (a.last && now.getTime() - Date.parse(a.last) < ASK_EVERY_MS) return null;
  const filled = { city: Boolean(cityOf(u)), wake: a.set.includes("wake"), address: a.set.includes("address") };
  const field = ASK_ORDER.find((k) => !filled[k] && !a.off.includes(k));
  if (!field) return null;
  const never = { text: "Не скажу", data: `you:${field}:never` };
  if (field === "city") {
    return { field, text: "Кстати, из какого вы города? Напишите мне название — запишу, и часы встанут по вашему поясу.", buttons: [{ text: "Потом", data: "you:city:later" }, never] };
  }
  if (field === "wake") {
    return { field, text: "А во сколько вы обычно встаёте? До этого часа я на ПК буду спать.", buttons: [...[6, 7, 8, 9].map((h) => ({ text: `${h}:00`, data: `you:wake:${h}` })), never] };
  }
  const name = u.name.trim();
  return { field, text: "Как мне к вам обращаться?", buttons: [
    { text: "Хозяин", data: "you:address:master" }, { text: "Хозяйка", data: "you:address:mistress" },
    ...(name ? [{ text: `По имени — ${name}`.slice(0, 40), data: "you:address:name" }] : []), never,
  ] };
}

async function askSave(store: Store, u: User, change: (a: AskState) => void) {
  const fresh = (await store.user(u.id)) ?? u;
  const a = askOf(fresh);
  change(a);
  await store.updateUser(u.id, { ask: JSON.stringify(a) });
}

/** Виджет показал вопрос: следующий — не раньше чем через 3 дня. Чужой или уже не нужный вопрос — ничего. */
export async function askShown(store: Store, u: User, field: string, now = new Date()): Promise<boolean> {
  if (askNext(u, now)?.field !== field) return false;
  await askSave(store, u, (a) => { a.last = now.toISOString(); });
  return true;
}

const offerKey = (u: User) => `youoffer:${u.id}`;
interface Offer { city?: City; wake?: number }

/** Человек сам назвал в разговоре город или час подъёма — что предложить записать. Уже так же в профиле — ничего. */
export async function aboutOffer(store: Store, u: User, about: { city?: string | null; wake?: number | null },
  cities: (q: string) => Promise<City[]> = findCities): Promise<{ text: string; buttons: YouButton[] } | null> {
  const offer: Offer = {};
  const parts: string[] = [];
  const cur = cityOf(u);
  const name = about.city?.trim();
  if (name && cur?.name.toLowerCase() !== name.toLowerCase()) {
    const c = (await cities(name))[0];
    if (c && c.name.toLowerCase() !== cur?.name.toLowerCase()) {
      offer.city = c;
      parts.push(`город — ${c.name}${c.region && c.region !== c.name ? ` (${c.region})` : ""}${c.tz !== u.tz ? `, часы — по ${tzOffset(c.tz)}` : ""}`);
    }
  }
  const w = about.wake;
  if (typeof w === "number" && (WAKES as readonly number[]).includes(w) && !(askOf(u).set.includes("wake") && u.wake === w)) {
    offer.wake = w;
    parts.push(`подъём — ${w}:00`);
  }
  if (!parts.length) return null;
  await store.kvSet(offerKey(u), JSON.stringify(offer));
  return { text: `Записать в профиль: ${parts.join(", ")}?`, buttons: [{ text: "✅ Да", data: "you:offer:yes" }, { text: "✖ Нет", data: "you:offer:no" }] };
}

/** Кнопка «you:…» — из облачка виджета, Telegram или push. Возвращает ответ и сменился ли пояс (тогда напоминания — заново). */
export async function youButton(store: Store, u: User, data: string, now = new Date()): Promise<{ text: string; tzChanged: boolean }> {
  const m = data.match(/^you:(city|wake|address|offer):(\w+)$/);
  if (!m) throw new Error("неизвестная кнопка");
  const [, field, v] = m;
  const done = (text: string, tzChanged = false) => ({ text, tzChanged });
  if (field === "offer") {
    const raw = await store.kvGet(offerKey(u));
    await store.kvSet(offerKey(u), "");
    if (!raw) return done("Это уже решили.");
    if (v !== "yes") return done("Хорошо, не записываю.");
    const o = JSON.parse(raw) as Offer;
    const r = await saveYou(store, u, { ...(o.city ? { city: o.city } : {}), ...(o.wake ? { wake: o.wake } : {}) });
    const what = [o.city ? `город ${o.city.name}` : "", o.wake ? `подъём ${o.wake}:00` : ""].filter(Boolean).join(", ");
    return done(`Записала в профиль: ${what}.${r.tzChanged ? ` Часы теперь по ${tzOffset((await store.user(u.id))!.tz)}.` : ""}`, r.tzChanged);
  }
  // Ответ на вопрос облачка — следующий тоже не раньше чем через 3 дня (если показ не отметился).
  await askSave(store, u, (a) => {
    if (!a.last) a.last = now.toISOString();
    if (v === "never" && !a.off.includes(field)) a.off.push(field);
  });
  if (v === "never") return done("Хорошо, больше не спрашиваю. Если передумаете — «Персонализация → О вас» на сайте.");
  if (v === "later") return done("Хорошо, спрошу в другой раз.");
  const fresh = (await store.user(u.id))!;
  if (field === "wake") {
    await saveYou(store, fresh, { wake: Number(v) });
    return done(`Поняла: до ${Number(v)}:00 — тишина.`);
  }
  if (field === "address" && (ADDRESSES as readonly string[]).includes(v)) {
    await saveYou(store, fresh, { address: v as Address });
    return done(`Хорошо, ${addressWord((await store.user(u.id))!)} 🙂`);
  }
  throw new Error("неизвестная кнопка");
}
