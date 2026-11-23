import type { EventRow, Store, TaskRow, User } from "./db.ts";
import { addDays, dayKey, timeOf } from "./time.ts";
import { callAs, cityOf, type City } from "./you.ts";

// Погода утром (ревью docs/review/погода-утром-2026-11-20.html, сделано 21.11.2026). Не прогноз, а совет: какая погода и какое
// одно дело дня она задевает. Прогноз по часам на сегодня — Open-Meteo (без ключа, некоммерческое использование), по координатам
// города из «О вас»; наружу уходят только координаты. Один запрос на город в день, повтор не раньше чем через 3 ч (для «дождь
// через час»). Фраза — из заготовок, без модели: дёшево и без выдуманных чисел.

/** Один час прогноза: h — час по времени города, t — °C, p — осадки мм, pp — вероятность %, code — код погоды WMO, wind — м/с. */
export interface Hour { h: number; t: number; p: number; pp: number; code: number; wind: number }

/** Пороги — в одном месте: мороз и жара (°C), сильный ветер (м/с), осадки (мм за час). */
export const WX_LIMITS = { frost: -15, heat: 27, wind: 15, snowWind: 10, wetMm: 0.2, wetProb: 60 };

export type WxKind = "clear" | "rain" | "snow" | "frost" | "storm" | "heat" | "fog" | "gray";

/** Для тестов: чем ходить в сеть (по умолчанию — fetch). */
export const weatherNet: { fetch: typeof fetch } = { fetch: (...a) => fetch(...a) };

const REFRESH_MS = 3 * 3600_000;
const cache = new Map<string, { at: number; hours: Hour[] }>();

/** Почасовой прогноз на день по городу; сеть не ответила за 4 с или ответ битый — null. Кэш общий для всех из этого города. */
export async function forecast(c: Pick<City, "lat" | "lon" | "tz">, day: string, now = Date.now()): Promise<Hour[] | null> {
  const key = `${c.lat.toFixed(2)},${c.lon.toFixed(2)}:${day}`;
  const had = cache.get(key);
  if (had && now - had.at < REFRESH_MS) return had.hours;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&timezone=${encodeURIComponent(c.tz)}` +
    `&hourly=temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m&wind_speed_unit=ms&start_date=${day}&end_date=${day}`;
  try {
    const res = await weatherNet.fetch(url, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`погода: ${res.status}`);
    const j = (await res.json()) as { hourly?: Record<string, (number | string | null)[]> };
    const hr = j.hourly ?? {};
    const hours = (hr.time ?? []).map((t, i) => ({
      h: Number(String(t).slice(11, 13)), t: Number(hr.temperature_2m?.[i] ?? NaN), p: Number(hr.precipitation?.[i] ?? 0),
      pp: Number(hr.precipitation_probability?.[i] ?? 0), code: Number(hr.weather_code?.[i] ?? 0), wind: Number(hr.wind_speed_10m?.[i] ?? 0),
    })).filter((x) => Number.isFinite(x.h) && Number.isFinite(x.t));
    if (hours.length < 12) throw new Error("погода: мало часов");
    for (const k of cache.keys()) if (!k.endsWith(`:${day}`)) cache.delete(k);
    cache.set(key, { at: now, hours });
    return hours;
  } catch (e) {
    console.warn("[weather]", (e as Error).message);
    return had?.hours ?? null; // старый прогноз дня лучше, чем ничего
  }
}
/** Только для тестов: забыть прогнозы. */
export const forgetForecasts = () => cache.clear();

// Коды погоды WMO: 0–3 ясно…пасмурно, 45/48 туман, 51–57 морось, 61–67 дождь (56/57/66/67 — ледяные), 71–77 снег, 80–82 ливень,
// 85/86 снегопад, 95–99 гроза.
const isSnow = (c: number) => (c >= 71 && c <= 77) || c === 85 || c === 86;
const isIce = (c: number) => [56, 57, 66, 67].includes(c);
const isThunder = (c: number) => c >= 95;
const wet = (x: Hour) => x.p >= WX_LIMITS.wetMm || (x.pp >= WX_LIMITS.wetProb && x.code >= 51);
/** Опасный час: гроза, ледяной дождь (гололёд), сильный ветер, метель. */
function danger(x: Hour): string | null {
  if (isThunder(x.code)) return "гроза";
  if (isIce(x.code)) return "гололёд";
  if (isSnow(x.code) && wet(x) && x.wind >= WX_LIMITS.snowWind) return "метель";
  if (x.wind >= WX_LIMITS.wind) return "сильный ветер";
  return null;
}
function iconOf(x: Hour): string {
  if (isThunder(x.code)) return "⛈";
  if (danger(x) === "метель") return "🌬";
  if (isSnow(x.code)) return "🌨";
  if (x.code >= 51 || wet(x)) return "🌧";
  if (x.code === 45 || x.code === 48) return "🌫";
  if (x.t <= WX_LIMITS.frost) return "❄️";
  return x.code === 0 ? "☀️" : x.code <= 2 ? "🌤" : "☁️";
}
/** Небо над панелью виджета для этого часа: какие частицы. */
function skyOf(x: Hour | undefined): string {
  if (!x) return "";
  if (danger(x) === "метель") return "storm";
  if (isSnow(x.code) && wet(x)) return "snow";
  if (wet(x) || isThunder(x.code)) return "rain";
  if (x.t <= WX_LIMITS.frost) return "frost";
  if (x.code === 45 || x.code === 48 || x.code === 3) return "gray";
  return x.code <= 1 ? "sun" : "";
}
export const degrees = (t: number) => { const r = Math.round(t); return r > 0 ? `+${r}°` : r < 0 ? `−${-r}°` : "0°"; };

export interface DayWeather {
  kind: WxKind;
  /** Опасная погода: что именно (метель, гроза, гололёд, сильный ветер), иначе "". */
  danger: string;
  /** Часы, которые погода задевает: [from, to). Мороз, жара, ясно — весь день. */
  from: number; to: number;
  icon: string; temp: string; min: number; max: number; wind: number;
  parts: { name: string; icon: string; temp: string; hot: boolean }[];
  /** Частицы сейчас (виджет). */
  sky: string;
}

/** Погода дня с часа now (прошедшие часы не в счёт). */
export function dayWeather(hours: Hour[], now: number): DayWeather {
  const rest = hours.filter((x) => x.h >= now);
  const day = rest.length ? rest : hours.slice(-1);
  const cur = hours.find((x) => x.h === now) ?? day[0];
  const min = Math.min(...day.map((x) => x.t)), max = Math.max(...day.map((x) => x.t)), wind = Math.max(...day.map((x) => x.wind));
  const span = (ok: (x: Hour) => boolean) => {
    const hit = day.filter(ok);
    return hit.length ? { from: hit[0].h, to: hit.at(-1)!.h + 1 } : null;
  };
  let kind: WxKind = "gray", dang = "", win = { from: 0, to: 24 };
  const bad = span((x) => danger(x) !== null);
  const snow = span((x) => isSnow(x.code) && wet(x));
  const rain = span((x) => wet(x) && !isSnow(x.code));
  if (bad) { kind = "storm"; win = bad; dang = danger(day.find((x) => x.h === bad.from)!) ?? ""; }
  else if (min <= WX_LIMITS.frost) kind = "frost";
  else if (snow) { kind = "snow"; win = snow; }
  else if (rain) { kind = "rain"; win = rain; }
  else if (max >= WX_LIMITS.heat) kind = "heat";
  else if (day.filter((x) => x.h < 12 && (x.code === 45 || x.code === 48)).length) { kind = "fog"; win = span((x) => x.code === 45 || x.code === 48) ?? win; }
  else if (day.filter((x) => x.code <= 1).length * 2 >= day.length) kind = "clear";
  const PARTS: [string, number, number][] = [["утро", 6, 12], ["день", 12, 18], ["вечер", 18, 24]];
  const parts = PARTS.map(([name, a, b]) => {
    const hs = hours.filter((x) => x.h >= a && x.h < b);
    const mid = hs[Math.floor(hs.length / 2)] ?? cur;
    const worst = hs.find((x) => danger(x)) ?? hs.find((x) => wet(x)) ?? mid;
    return { name, icon: iconOf(worst), temp: degrees(mid.t), hot: kind !== "gray" && kind !== "clear" && win.from < b && win.to > a && b > now };
  });
  return { kind, danger: dang, ...win, icon: iconOf(cur), temp: degrees(cur.t), min, max, wind, parts, sky: skyOf(cur) };
}

/** Дело на улице — по словам в названии. Дома (почта, отчёт, уборка) — не трогаем. */
const OUTDOOR = /(пробежк|бегать|бег\b|пробег|прогулк|гулять|погулять|шиномонтаж|автосервис|мойк|магазин|купить|покупк|рын[ок]|аптек|почт[ау]\b|забрать|отвезти|отвез|съездить|поездк|поехать|ехать|еду\b|вокзал|аэропорт|дач[аеуи]|сад\b|огород|парк|велосипед|самокат|футбол|рыбалк|пикник|шашлык|встреч|в гости|гости\b|кафе|ресторан|кино|театр|концерт|выставк|экскурси|сходить|выйти|выгулять|собак|такси|электричк|машин[ауы]|забор|стадион|каток|лыж|бассейн|спортзал|зал\b|тренировк)/i;
export const outdoor = (title: string) => OUTDOOR.test(title.toLowerCase().replace(/ё/g, "е"));

export interface Deed { plan: EventRow | null; task: TaskRow | null }
const hourOf = (time: string) => Number(time.slice(0, 2));

/** Пять правил: 1) дело на улице; 2) время плана попадает в погоду, прошедшее не берём; 3) один, ближайший; нет плана — задача без
 *  времени, которую погода касается; 4) опасная погода — кнопки у этого плана (решает вызывающий); 5) погода ничему не мешает —
 *  ничего не выбираем. */
export function pickDeed(w: DayWeather, events: EventRow[], tasks: TaskRow[], nowMin: number, today: string): Deed {
  if (w.kind === "gray") return { plan: null, task: null };
  const plans = events
    .filter((e) => e.time && e.date_iso === today && (!e.status || e.status === "active") && outdoor(e.title))
    .filter((e) => hourOf(e.time!) * 60 + Number(e.time!.slice(3, 5)) >= nowMin)
    .filter((e) => hourOf(e.time!) >= w.from && hourOf(e.time!) < w.to)
    .sort((a, b) => a.time!.localeCompare(b.time!));
  if (plans[0]) return { plan: plans[0], task: null };
  if (w.kind === "clear" || w.kind === "fog") return { plan: null, task: null };
  const task = tasks.find((t) => (!t.due_date || t.due_date <= today) && outdoor(t.title)) ?? null;
  return { plan: null, task };
}

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const HOUR_WORDS: Record<number, string> = { 12: "с обеда", 13: "с часу дня", 17: "с пяти вечера", 18: "с шести вечера", 19: "с семи вечера", 20: "с восьми вечера" };
const since = (w: DayWeather, now: number) => (w.from <= now ? "сейчас" : HOUR_WORDS[w.from] ?? `с ${hh(w.from)}`);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export interface WeatherSay {
  text: string; pose: string; emotion: string;
  /** Значок у задетого плана в панели виджета. */
  hit: string;
}

/** Фраза без приветствия: сначала погода, потом одно дело. first — первый снег за сезон. */
export function weatherPhrase(w: DayWeather, d: Deed, now: number, first = false): WeatherSay {
  const at = (e: EventRow) => `${e.title.charAt(0).toLowerCase()}${e.title.slice(1)} в ${e.time}`;
  const when = since(w, now);
  const t = w.temp;
  let head: string, item = "", soft = "", pose = "neutral", emotion = "neutral", hit = "";
  switch (w.kind) {
    case "clear":
      head = `Солнце и ${t}`; pose = "happy"; emotion = "happy"; hit = "☀️";
      item = d.plan ? `для плана «${d.plan.title}» в ${d.plan.time} погода в самый раз.` : "";
      soft = w.max - w.min >= 3 ? `Днём до ${degrees(w.max)} — хороший день, чтобы выйти пройтись.` : "Хороший день, чтобы выйти пройтись.";
      break;
    case "rain":
      head = when === "сейчас" ? `Дождь, ${t}` : `${cap(when)} дождь`; pose = "remind"; emotion = "sad"; hit = "☂";
      item = d.plan ? `А у вас ${at(d.plan)} — зонт не забудьте ☂` : d.task
        ? (w.from > now ? `«${d.task.title}» лучше успеть до ${hh(w.from)}, пока сухо.` : `«${d.task.title}» — зонт не забудьте ☂`) : "";
      soft = "Если соберётесь выйти — зонт пригодится.";
      break;
    case "snow":
      head = `${first ? "Первый снег! ❄ " : ""}${when === "сейчас" ? `Снег, ${t}` : `${cap(when)} снег, ${t}`}`;
      pose = first ? "excited" : "happy"; emotion = "happy"; hit = "🌨";
      item = d.plan ? `А у вас ${at(d.plan)} — обувь лучше нескользкую.` : d.task
        ? (w.from > now ? `«${d.task.title}» лучше успеть до ${hh(w.from)}, пока не замело.` : `«${d.task.title}» — одевайтесь теплее.`) : "";
      soft = "Одевайтесь теплее.";
      break;
    case "frost":
      head = `Брр, ${degrees(w.min)}!`; pose = "tea"; hit = "🥶";
      item = d.plan ? `${cap(at(d.plan))} — шапку и перчатки!` : d.task ? `«${d.task.title}» — шапку и перчатки!` : "";
      soft = "Сидим в тепле 🍵";
      break;
    case "storm": {
      const what = w.danger || "непогода";
      head = `${cap(when)} ${what}${w.wind >= WX_LIMITS.wind ? `, ветер до ${Math.round(w.wind)} м/с` : ""}`;
      pose = "worried"; hit = "⚠";
      item = d.plan ? `А у вас ${at(d.plan)} — может, перенесём?` : d.task ? `«${d.task.title}» лучше отложить.` : "";
      soft = "Лучше никуда не выходить без нужды.";
      break;
    }
    case "heat":
      head = `Жара до ${degrees(w.max)}`; pose = "happy"; emotion = "happy"; hit = "🥵";
      item = d.plan ? `А у вас ${at(d.plan)} — воду и кепку возьмите.` : d.task ? `«${d.task.title}» лучше утром, пока не жарко.` : "";
      soft = "Пейте воду почаще.";
      break;
    case "fog":
      head = `Утром туман, ${t}`; hit = "🌫";
      item = d.plan ? `А у вас ${at(d.plan)} — на дороге осторожнее.` : "";
      soft = "К обеду должно развеяться.";
      break;
    default:
      head = `Пасмурно, ${t}, без дождя`;
      soft = "Хороший день, чтобы разобрать хвосты 😌";
  }
  const body = item || soft;
  // «Солнце и +2° — для плана …», «Брр, −18°! Пробежка …», «С обеда снег, −1°. А у вас …»
  const glue = /^[а-яё]/.test(body) ? " — " : /[!?…]$/.test(head) ? " " : ". ";
  return { text: `${head}${glue}${body}`, pose, emotion, hit: d.plan || d.task ? hit : "" };
}

/** Зимний сезон для «первого снега»: июль–июнь, «2026». */
const season = (day: string) => String(Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) < 7 ? 1 : 0));

export interface WeatherView extends WeatherSay {
  city: string; day: string; kind: WxKind; danger: string; icon: string; temp: string; sky: string;
  parts: DayWeather["parts"];
  /** Задетый план (для значка и кнопок «Перенести на завтра» в опасную погоду). */
  plan: { id: number; title: string; time: string } | null;
  task_id: number | null;
  /** Кнопки «Перенести на завтра» / «Оставить» — у плана в опасную погоду. */
  move: boolean;
  /** Сухие факты для модели (утренний список пишет строку погоды своими словами): только числа из прогноза. */
  facts: string;
}

const KIND_WORD: Record<WxKind, string> = { clear: "ясно", rain: "дождь", snow: "снег", frost: "мороз", storm: "опасная погода", heat: "жара", fog: "туман", gray: "пасмурно, без осадков" };

/** Факты дня одной строкой: город, сейчас, разброс, что и когда, ветер, задетое дело. */
export function weatherFacts(city: string, w: DayWeather, d: Deed, now: number, first: boolean): string {
  const span = w.from <= now && w.to >= 24 ? "весь день" : `с ${hh(Math.max(w.from, now))} до ${hh(Math.min(w.to, 24))}`;
  const what = w.kind === "storm" ? `${w.danger || "непогода"} ${span}` : ["rain", "snow", "fog"].includes(w.kind) ? `${KIND_WORD[w.kind]} ${span}` : KIND_WORD[w.kind];
  const deed = d.plan ? `под погоду попадает план «${d.plan.title}» в ${d.plan.time}` : d.task ? `под погоду попадает задача «${d.task.title}» (без времени)` : "погода не мешает делам";
  return [`${city}: сейчас ${w.temp}, за день от ${degrees(w.min)} до ${degrees(w.max)}`, what + (first ? " (первый снег за сезон)" : ""),
    `ветер до ${Math.round(w.wind)} м/с`, deed].join("; ");
}

/** Погода дня для человека: null — нет города или нет прогноза (тогда утро как раньше). */
export async function weatherFor(store: Store, u: User, at = new Date()): Promise<WeatherView | null> {
  const c = cityOf(u);
  if (!c) return null;
  const today = dayKey(at, c.tz);
  const hours = await forecast(c, today, at.getTime());
  if (!hours) return null;
  const nowMin = (([h, m]) => h * 60 + m)(timeOf(at, c.tz).split(":").map(Number));
  const now = Math.floor(nowMin / 60);
  const w = dayWeather(hours, now);
  const d = pickDeed(w, await store.eventsBetween(u.id, today, today), await store.openTasks(u.id), nowMin, today);
  let first = false;
  if (w.kind === "snow") {
    // Первый снег сезона: отмечаем день, когда он впервые пришёл в погоду этого человека; в этот день — «Первый снег!».
    const key = `wx:snow:${u.id}:${season(today)}`;
    const was = await store.kvGet(key);
    if (!was) await store.kvSet(key, today);
    first = !was || was === today;
  }
  const s = weatherPhrase(w, d, now, first);
  return {
    ...s, text: callAs(s.text, u), city: c.name, day: today, kind: w.kind, danger: w.danger, icon: w.icon, temp: w.temp, sky: w.sky, parts: w.parts,
    plan: d.plan ? { id: d.plan.id, title: d.plan.title, time: d.plan.time! } : null, task_id: d.task?.id ?? null,
    move: w.kind === "storm" && Boolean(d.plan), facts: weatherFacts(c.name, w, d, now, first),
  };
}

/** «Дождь через час» (настройка weather_rain): дождь начнётся в ближайший час, а план на улице попадает под него. Иначе null. */
export async function rainSoon(store: Store, u: User, at = new Date()): Promise<string | null> {
  const c = cityOf(u);
  if (!c) return null;
  const today = dayKey(at, c.tz);
  const hours = await forecast(c, today, at.getTime());
  if (!hours) return null;
  const nowMin = (([h, m]) => h * 60 + m)(timeOf(at, c.tz).split(":").map(Number));
  const start = hours.find((x, i) => x.h * 60 > nowMin && x.h * 60 - nowMin <= 60 && wet(x) && !isSnow(x.code) && !(hours[i - 1] && wet(hours[i - 1])));
  if (!start) return null;
  let end = start.h;
  while (hours.find((x) => x.h === end + 1 && wet(x))) end++;
  const plan = (await store.eventsBetween(u.id, today, today))
    .filter((e) => e.time && (!e.status || e.status === "active") && outdoor(e.title))
    .find((e) => hourOf(e.time!) >= start.h && hourOf(e.time!) <= end);
  if (!plan) return null;
  return callAs(`☂ Через час дождь, а в ${plan.time} «${plan.title}» — зонт не забудьте.`, u);
}

/** «Перенести на завтра» (кнопка в метель): план сегодня → завтра в то же время; back — вернуть на сегодня. */
export async function moveToTomorrow(store: Store, u: User, eventId: number, back: boolean, at = new Date()): Promise<EventRow | null> {
  const today = dayKey(at, u.tz);
  const e = (await store.eventsBetween(u.id, today, addDays(today, 1))).find((x) => x.id === eventId);
  if (!e || e.date_iso !== (back ? addDays(today, 1) : today)) return null;
  await store.updateEvent(e.id, { date_iso: back ? today : addDays(today, 1) });
  return { ...e, date_iso: back ? today : addDays(today, 1) };
}
