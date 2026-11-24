import type { Store } from "./db.ts";
import { applyTariffs, signupsEnvClosed, tariffs, TariffError } from "./tariffs.ts";

// Переключатели функций (этап 6 «Тарифы и управление», 24.11.2026; макет docs/review/тарифы-и-управление-макет-2026-11-24.html,
// вкладка «Переключатели»). Крупную функцию можно выключить и включить из админки без выкладки: строка feature_switches (шаг 36),
// нет строки — включено (после выкладки поведение то же, что было). Сервер перечитывает таблицу раз в SWITCH_RELOAD_MS (watchSwitches
// в index.ts) и сразу после изменения на этом процессе — как tariffs(). Выключенная функция отвечает человеку коротким текстом
// (SWITCHES[].off, по образцу OFF_TEXT): ИИ, картинки и голос — в AiGate (access.ts), push — в Push.send (push.ts), регистрация —
// тот же выключатель signupsOpen тарифов (одно место вместо двух; SIGNUPS_OPEN=0 в .env — аварийное закрытие поверх).
// Каждое изменение — с причиной в журнал администратора (switch_on / switch_off; регистрация — строка тарифов «tariff»).
// Отличие от макета: в макете — доли людей и «только друзьям»; здесь только вкл/выкл (виджет без выпуска не меняется, а доли нужны
// функциям виджета — их выпуск уже поэтапный, releases.ts).

export const SWITCH_RELOAD_MS = 60_000;

export type SwitchId = "ai" | "draw" | "voice" | "push" | "signups";
export interface SwitchSpec { id: SwitchId; title: string; hint: string; off: string }

/** Что можно выключить. off — что увидит человек, пока функция выключена (короткие тексты — на согласование). */
export const SWITCHES: readonly SwitchSpec[] = [
  { id: "ai", title: "Ответы ИИ", hint: "разбор сообщений, /ask, поправки, сводки — всё, что зовёт модель", off: "Разбор сообщений ненадолго выключен — отметки, записи и напоминания работают как обычно." },
  { id: "draw", title: "Картинки", hint: "«нарисуй…» — самая дорогая функция", off: "Картинки ненадолго выключены — остальное работает как обычно." },
  { id: "voice", title: "Голосовые", hint: "распознавание голосовых в боте, на сайте и в виджете", off: "Голосовые ненадолго выключены — напишите текстом, пожалуйста." },
  { id: "push", title: "Push-уведомления", hint: "в браузер и на телефон; лента, виджет и Telegram — как обычно", off: "Push-уведомления ненадолго выключены — письма приходят в Telegram и в ленту." },
  { id: "signups", title: "Регистрация новых", hint: "/start без приглашения; то же, что «Регистрация» в «Общих потолках»", off: "" },
];
export const SWITCH_IDS = SWITCHES.map((s) => s.id);

let off = new Set<string>();
let loadedAt = -Infinity;
let started = 0, applied = 0;

/** Включена ли функция сейчас на этом процессе. Регистрация — по тарифам (signupsOpen) и .env. */
export function switchOn(id: SwitchId): boolean {
  if (id === "signups") return tariffs().signupsOpen && !signupsEnvClosed();
  return !off.has(id);
}
/** Текст человеку, пока функция выключена. */
export const switchOffText = (id: SwitchId): string => SWITCHES.find((s) => s.id === id)!.off;
/** Только для тестов: выключить без базы (до следующего loadSwitches). */
export function overrideSwitches(ids: SwitchId[]): void {
  off = new Set(ids);
}

/** Перечитать таблицу сейчас; чтение, начатое раньше уже применённого, — мимо (как loadTariffs). */
export async function loadSwitches(store: Store, now = Date.now()): Promise<void> {
  const my = ++started;
  const rows = await store.featureSwitches();
  if (my > applied) {
    applied = my;
    off = new Set(rows.filter((r) => !r.enabled && (SWITCH_IDS as string[]).includes(r.id)).map((r) => r.id));
    loadedAt = now;
  }
}
export async function refreshSwitches(store: Store, now = Date.now()): Promise<boolean> {
  if (now - loadedAt < SWITCH_RELOAD_MS) return false;
  await loadSwitches(store, now);
  return true;
}
export function watchSwitches(store: Store, clock: () => number = Date.now): () => void {
  const t = setInterval(() => void refreshSwitches(store, clock()).catch((e) => console.error("[switches]", (e as Error).message)), SWITCH_RELOAD_MS / 4);
  t.unref?.();
  return () => clearInterval(t);
}

export class SwitchError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Включить или выключить функцию из админки (POST /api/admin/switches): причина обязательна, в журнал админа; сразу перечитать. */
export async function setSwitch(store: Store, by: number, body: unknown, now = new Date()) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 3) throw new SwitchError(400, "напишите причину (хотя бы 3 знака)");
  if (reason.length > 300) throw new SwitchError(400, "причина — не длиннее 300 знаков");
  const s = SWITCHES.find((x) => x.id === b.id);
  if (!s) throw new SwitchError(404, "нет такой функции");
  if (typeof b.on !== "boolean") throw new SwitchError(400, "вкл — да или нет");
  if (switchOn(s.id) === b.on && s.id !== "signups") throw new SwitchError(400, "уже так");
  if (s.id === "signups") {
    // Регистрация — тот же выключатель, что в «Общих потолках» (строка истории тарифов и журнал «изменил тарифы»).
    try {
      await applyTariffs(store, by, { signupsOpen: b.on }, reason, now);
    } catch (e) {
      if (e instanceof TariffError) throw new SwitchError(e.status, e.message);
      throw e;
    }
  } else {
    await store.setFeatureSwitch(s.id, b.on, now, by);
    await store.addAdminLog(by, b.on ? "switch_on" : "switch_off", s.id, now, reason);
    await loadSwitches(store, now.getTime());
  }
  return switchesView(store);
}

/** Раздел «Переключатели»: функции, вкл/выкл, когда и кем (#id) менялось, текст человеку. */
export async function switchesView(store: Store) {
  const rows = new Map((await store.featureSwitches()).map((r) => [r.id, r]));
  return {
    reload_ms: SWITCH_RELOAD_MS,
    /** SIGNUPS_OPEN=0 в .env: регистрация закрыта поверх переключателя. */
    env_closed: signupsEnvClosed(),
    switches: SWITCHES.map((s) => {
      const r = rows.get(s.id);
      return { id: s.id, title: s.title, hint: s.hint, off_text: s.off, on: switchOn(s.id), updated_at: r?.updated_at ?? null, updated_by: r ? `#${r.updated_by}` : null };
    }),
  };
}
