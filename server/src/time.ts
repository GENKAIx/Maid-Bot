// Даты и время в часовом поясе пользователя. Внутри базы моменты — ISO UTC,
// дни — "YYYY-MM-DD" по местному времени.

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: number; // 0 — воскресенье
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(at: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(at).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function timeOf(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

export function isDayKey(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isTime(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** "7:05" → "07:05"; всё остальное — null. */
export function normalizeTime(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const t = `${m[1].padStart(2, "0")}:${m[2]}`;
  return isTime(t) ? t : null;
}

export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(...(from.split("-").map(Number) as [number, number, number]));
  const b = Date.UTC(...(to.split("-").map(Number) as [number, number, number]));
  return Math.round((b - a) / 86400000);
}

/** Момент UTC для местных даты и времени в зоне tz. */
export function zonedToUtc(key: string, time: string, tz: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  // Две итерации хватает и на переходах летнего времени.
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    guess += wanted - seen;
  }
  return new Date(guess);
}

/** Ближайший (сегодня или позже) день с тем же месяцем и числом. 29 февраля — 28-го в невисокосный. */
export function nextYearly(dateIso: string, today: string): string {
  const [, m, d] = dateIso.split("-").map(Number);
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    let dd = d;
    while (!isDayKey(`${y}-${pad(m)}-${pad(dd)}`)) dd--;
    const k = `${y}-${pad(m)}-${pad(dd)}`;
    if (k >= today) return k;
  }
  return dateIso;
}

const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const WEEKDAY_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const WEEKDAY_LONG = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

export function weekdayOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "8 ноября, Сб" */
export function humanDay(key: string, withYear = false): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}${withYear ? ` ${y}` : ""}, ${WEEKDAY_SHORT[weekdayOf(key)]}`;
}

export function weekdayLong(key: string): string {
  return WEEKDAY_LONG[weekdayOf(key)];
}

export function durationHuman(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}
