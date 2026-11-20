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
  return {
    name: u.name, address: u.address as Address, call: addressWord(u),
    city, tz: u.tz, tz_offset: tzOffset(u.tz, now), tz_default: config.defaultTimezone, tz_from_city: Boolean(city && city.tz === u.tz),
    wake: u.wake, bed: u.bed, birthday: info.birthday, height: info.height,
    weight: weight ? weight.value : null,
    traits: { debuffs: traits.filter((t) => t.kind === "debuff").length, buffs: traits.filter((t) => t.kind === "buff").length },
  };
}

export interface YouPatch {
  address?: Address; name?: string;
  /** Новый город (из findCities) или null — стереть. Часовой пояс города ставится сам, если пояс не задан тем же запросом. */
  city?: City | null;
  tz?: string | null;
  wake?: number; bed?: string;
  birthday?: string; height?: number | null;
}

/** Записать «О вас». Возвращает, сменился ли часовой пояс (тогда напоминания о планах перекладываются заново). */
export async function saveYou(store: Store, u: User, p: YouPatch): Promise<{ tzChanged: boolean }> {
  const patch: Partial<User> = {};
  if (p.address !== undefined) patch.address = p.address;
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
  }
  if (tz !== u.tz) patch.tz = tz;
  if (p.wake !== undefined) {
    if (!(WAKES as readonly number[]).includes(p.wake)) throw new Error(`подъём — с ${WAKES[0]}:00 до ${WAKES[WAKES.length - 1]}:00`);
    patch.wake = p.wake;
  }
  if (p.bed !== undefined) {
    if (!(BEDS as readonly string[]).includes(p.bed)) throw new Error("нет такого времени отбоя");
    patch.bed = p.bed;
  }
  if (p.birthday !== undefined || p.height !== undefined) {
    const prof: Partial<ProfileInfo> = {};
    if (p.birthday !== undefined) prof.birthday = p.birthday;
    if (p.height !== undefined) prof.height = p.height;
    await saveProfile(store, u.id, prof);
  }
  if (Object.keys(patch).length) await store.updateUser(u.id, patch);
  return { tzChanged: tz !== u.tz };
}
