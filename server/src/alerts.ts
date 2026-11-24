import { config } from "./config.ts";
import type { AlertRuleRow, BillingKind, Store } from "./db.ts";
import { newcomersText } from "./invite.ts";
import { autoPause, crashRatio, readRelease, RELEASE_CRASH_DAYS, RELEASE_CRASH_MIN_USERS, releaseCrashes, releaseDone } from "./releases.ts";
import { tariffs } from "./tariffs.ts";
import { addDays } from "./time.ts";

// Оповещения владельцу по порогам (этап 4 «Тарифы и управление», 24.11.2026; макет docs/review/тарифы-и-управление-макет-2026-11-24.html,
// вкладка «Оповещения»). Одна система вместо прежних четырёх: тревоги admin-stats.ts adminAlerts (перерасход, неразобранные), письмо
// о потолке регистраций из bot.ts, письмо о каждой оплате из billing.ts и сводка новичков из index.ts — теперь правила здесь.
// Правила лежат в alert_rules (шаг 34): вкл/выкл, порог, окно, «не чаще раза в». Проверка — раз в ALERT_CHECK_MS из такта
// планировщика (index.ts) и кнопкой «Проверить сейчас». Состояние правила: норма → сработало (письмо; в пределах «не чаще» —
// без письма, firing = 1) → пока держится, повтор не чаще раза в every_min → «снова норма» (у правил с recover). События
// (возвраты, оплаты) копятся с отметки mark и уходят одним письмом, не чаще раза в every_min. Выключенное правило молчит.
// Письмо — владельцу в Telegram (как код входа: не в ленту уведомлений, её видит виджет): коротко, числа и номера аккаунтов,
// без имён, логинов и текстов людей; внизу — ссылка в админку. Каждое письмо (и подавленное) — строка alert_log.

export const ALERT_CHECK_MS = 5 * 60_000;
/** Доля ошибок ИИ считается, только если вызовов за окно не меньше. */
export const ALERT_LLM_MIN_CALLS = 10;
/** Всплеск расхода: не раньше, чем день дорос до стольких долларов (иначе «в 5 раз» от копеек). */
export const ALERT_SPIKE_MIN_USD = 0.5;
/** Сводка новичков — раз в сутки после этого часа UTC (как прежде). */
export const NEWCOMERS_HOUR_UTC = 6;

export type AlertRuleId =
  | "spend_day" | "spend_spike" | "llm_errors" | "failed_msgs" | "send_fail" | "webhook" | "signup_cap"
  | "refund" | "payment" | "backup" | "db_size" | "newcomers" | "release_crash" | "support_new";

/** state — условие по числу сейчас; event — события с отметки (сколько накопилось); daily — сводка раз в сутки. */
export interface AlertSpec {
  id: AlertRuleId; title: string; unit: string; kind: "state" | "event" | "daily";
  /** Писать «снова норма», когда условие прошло (у расхода за день — нет: день просто кончается). */
  recover: boolean;
  /** Окно в минутах меняется (иначе оно задано смыслом правила: день, час, «с прошлого письма»). */
  window: boolean;
  min: number; max: number; int: boolean;
  enabled: boolean; threshold: number; window_min: number; every_min: number;
  hint: string;
}

const spec = (s: Omit<AlertSpec, "int" | "min" | "max"> & Partial<Pick<AlertSpec, "int" | "min" | "max">>): AlertSpec => ({ int: true, min: 1, max: 100_000, ...s });

/** Правила и их значения по умолчанию: тихие — повторы не чаще раза в час и реже, ночная сводка одна. Порог расхода за день —
 *  80% общего потолка проб в день (tariffs().trialPoolDayUsd) на момент первого чтения, дальше — как поставит владелец. */
export function alertSpecs(): AlertSpec[] {
  const pool = Math.round(tariffs().trialPoolDayUsd * 0.8 * 100) / 100;
  return [
    spec({ id: "spend_day", title: "Расход на ИИ за день (UTC) — от", unit: "$", kind: "state", recover: false, window: false, int: false, min: 0.01, max: 10_000,
      enabled: true, threshold: pool, window_min: 1440, every_min: 360, hint: `по умолчанию — 80% общего потолка проб ($${pool})` }),
    spec({ id: "spend_spike", title: "Расход за день больше обычного — в", unit: "раз", kind: "state", recover: false, window: false, int: false, min: 1.1, max: 100,
      enabled: true, threshold: 3, window_min: 1440, every_min: 360, hint: `обычный — средний за 14 дней; не раньше $${ALERT_SPIKE_MIN_USD} за день` }),
    spec({ id: "llm_errors", title: "Доля ошибок ИИ за окно — от", unit: "%", kind: "state", recover: true, window: true, max: 100,
      enabled: true, threshold: 20, window_min: 60, every_min: 60, hint: `при ${ALERT_LLM_MIN_CALLS} вызовах за окно и больше` }),
    spec({ id: "failed_msgs", title: "Неразобранных сообщений за окно — от", unit: "шт.", kind: "state", recover: true, window: true,
      enabled: true, threshold: 3, window_min: 60, every_min: 60, hint: "сообщения в ошибке: модель или сеть сбоят" }),
    spec({ id: "send_fail", title: "Не ушло в Telegram за окно — от", unit: "раз", kind: "state", recover: true, window: true,
      enabled: true, threshold: 5, window_min: 15, every_min: 60, hint: "сбои отправки сообщений; «бот заблокирован человеком» не в счёт" }),
    spec({ id: "webhook", title: "Telegram не достучался до сервера (вебхук) за окно — от", unit: "раз", kind: "state", recover: true, window: true, max: 1,
      enabled: true, threshold: 1, window_min: 15, every_min: 60, hint: "по ответу Telegram getWebhookInfo; без PUBLIC_URL (long polling) — не проверяется" }),
    spec({ id: "signup_cap", title: "Регистраций — доля потолка (час или сутки) от", unit: "%", kind: "state", recover: true, window: false, max: 1000,
      enabled: true, threshold: 100, window_min: 60, every_min: 60, hint: "потолки — «Общие потолки»; при 100% новых не пускает" }),
    spec({ id: "refund", title: "Возврат звёзд — от", unit: "шт.", kind: "event", recover: false, window: false,
      enabled: true, threshold: 1, window_min: 60, every_min: 10, hint: "и из админки, и из Telegram" }),
    spec({ id: "payment", title: "Новые оплаты — от", unit: "шт.", kind: "event", recover: false, window: false,
      enabled: true, threshold: 1, window_min: 60, every_min: 60, hint: "первые оплаты и продления одним письмом не чаще раза в час" }),
    spec({ id: "backup", title: "Копия базы не удалась или старше", unit: "ч", kind: "state", recover: true, window: false, max: 24 * 14,
      enabled: true, threshold: 26, window_min: 60, every_min: 360, hint: "ночная копия, отправка в Telegram; у Postgres — не проверяется" }),
    spec({ id: "db_size", title: "База больше", unit: "МБ", kind: "state", recover: true, window: false, max: 1_000_000,
      enabled: true, threshold: 500, window_min: 60, every_min: 1440, hint: "файл SQLite с журналом; сжатая копия больше 50 МБ в Telegram не влезет" }),
    spec({ id: "newcomers", title: "Сводка новых за сутки — от", unit: "чел.", kind: "daily", recover: false, window: false,
      enabled: true, threshold: 1, window_min: 1440, every_min: 1440, hint: `раз в сутки после ${String(NEWCOMERS_HOUR_UTC).padStart(2, "0")}:00 UTC, номера аккаунтов` }),
    // Этап 5: падения новой версии программы на ПК (releases.ts). Сработало — выпуск сам встаёт на паузу (один раз на версию).
    spec({ id: "release_crash", title: "Падения новой версии программы — больше прошлой в", unit: "раз", kind: "state", recover: true, window: false, int: false, min: 1.1, max: 100,
      enabled: true, threshold: 2, window_min: RELEASE_CRASH_DAYS * 1440, every_min: 360,
      hint: `доля людей с падением за ${RELEASE_CRASH_DAYS} дн., не меньше ${RELEASE_CRASH_MIN_USERS} человек; сработало — выпуск сам на паузу (раз на версию)` }),
    // Этап 6: новые обращения людей (support.ts) — одним письмом, только число (тексты — в карточке обращения в админке).
    spec({ id: "support_new", title: "Новые обращения людей — от", unit: "шт.", kind: "event", recover: false, window: false,
      enabled: true, threshold: 1, window_min: 60, every_min: 30, hint: "«Написать нам» на сайте; в письме только число, тексты — в «Обращениях»" }),
  ];
}
export const ALERT_IDS = alertSpecs().map((s) => s.id);

// ——— Сбои отправки в Telegram — в памяти процесса (index.ts зовёт noteSendFailure при каждой неудаче, кроме 403).
const sendFails: number[] = [];
export function noteSendFailure(err?: unknown, at = Date.now()) {
  if ((err as { error_code?: number } | undefined)?.error_code === 403) return; // человек заблокировал бота — не сбой сервера
  sendFails.push(at);
  if (sendFails.length > 1000) sendFails.splice(0, sendFails.length - 1000);
}
export const sendFailuresSince = (since: number) => sendFails.filter((t) => t >= since).length;
/** Для тестов. */
export const resetSendFailures = () => void sendFails.splice(0);

export interface AlertDeps {
  /** Письмо владельцу (всем админам) в Telegram; вернуть, скольким ушло. */
  notify: (text: string) => Promise<number>;
  /** Размер базы в байтах (null — не измерить: Postgres). */
  dbBytes?: () => number | null;
  /** Когда Telegram последний раз не смог доставить вебхук (мс) или null; не задано — long polling, правило молчит. */
  webhookErrorAt?: () => Promise<number | null>;
  /** Ссылка в админку (config.publicUrl). */
  publicUrl?: string;
}

type Measure = { value: number | null; hit: boolean; text: string; ok?: string };
export type AlertCheckRow = { id: AlertRuleId; value: number | null; hit: boolean; firing: number; sent: "fire" | "repeat" | "ok" | "held" | null; enabled: boolean };

const iso = (t: number) => new Date(t).toISOString();
const money = (n: number) => `$${n.toFixed(2)}`;
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export class AlertError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class Alerts {
  private lastCheck = 0;
  /** Первая проверка в этом процессе (мс): счётчик сбоев отправки живёт в памяти и после перезапуска пуст — пока после неё
   *  не прошло полное окно, send_fail не объявляет «снова норма» (иначе каждый перезапуск — ложное «✅» и новая тревога следом). */
  private firstCheckAt: number | null = null;
  private running: Promise<AlertCheckRow[]> | null = null;
  constructor(private store: Store, private deps: AlertDeps) {}

  /** Правила из базы; недостающие (первый запуск, новое правило) — дописать значениями по умолчанию. */
  async rules(now = new Date()): Promise<{ spec: AlertSpec; row: AlertRuleRow }[]> {
    const specs = alertSpecs();
    let rows = await this.store.alertRules();
    if (specs.some((s) => !rows.find((r) => r.id === s.id))) {
      await this.store.seedAlertRules(specs.map((s) => ({ id: s.id, enabled: s.enabled ? 1 : 0, threshold: s.threshold, window_min: s.window_min, every_min: s.every_min, mark: now.toISOString() })), now);
      rows = await this.store.alertRules();
    }
    return specs.map((s) => ({ spec: s, row: rows.find((r) => r.id === s.id)! }));
  }

  private link() {
    const url = this.deps.publicUrl ?? config.publicUrl;
    return url ? `\nАдминка → Оповещения: ${url}/admin/alerts` : "\nАдминка → Оповещения.";
  }

  /** Что показывает правило сейчас. value null — нечего мерить (нет данных, Postgres, long polling): состояние не меняется. */
  private async measure(s: AlertSpec, r: AlertRuleRow, now: Date): Promise<Measure> {
    const t = r.threshold;
    const win = iso(now.getTime() - r.window_min * 60_000);
    const utc = now.toISOString().slice(0, 10);
    switch (s.id) {
      case "spend_day": {
        const cost = (await this.store.usageDays(utc, utc)).reduce((x, d) => x + d.cost, 0);
        return { value: cost, hit: cost >= t, text: `⚠️ Расход на ИИ сегодня (UTC): ${money(cost)} — порог ${money(t)}. Подробности — «Расходы на модель».` };
      }
      case "spend_spike": {
        const rows = await this.store.usageDays(addDays(utc, -14), utc);
        const cost = rows.filter((d) => d.day === utc).reduce((x, d) => x + d.cost, 0);
        const avg = rows.filter((d) => d.day !== utc).reduce((x, d) => x + d.cost, 0) / 14;
        const x = avg > 0 ? cost / avg : cost > 0 ? Infinity : 0;
        return {
          value: Number.isFinite(x) ? x : null, hit: cost >= ALERT_SPIKE_MIN_USD && x >= t,
          text: `⚠️ Расход на ИИ сегодня ${money(cost)} — в ${Number.isFinite(x) ? x.toFixed(1) : "∞"} раза больше обычного (${money(avg)} в день за 2 недели).`,
        };
      }
      case "llm_errors": {
        const c = await this.store.alertLlmCalls(win);
        const share = c.calls ? (c.errors / c.calls) * 100 : 0;
        return {
          value: share, hit: c.calls >= ALERT_LLM_MIN_CALLS && share >= t,
          text: `⚠️ Ошибок ИИ за ${r.window_min} мин: ${Math.round(share)}% (${c.errors} из ${c.calls} вызовов), порог ${num(t)}%. Подробности — «Здоровье сервера».`,
          ok: `✅ Снова норма: ошибок ИИ за ${r.window_min} мин — ${Math.round(share)}% (${c.errors} из ${c.calls}).`,
        };
      }
      case "failed_msgs": {
        const n = await this.store.adminFailedSince(win);
        return { value: n, hit: n >= t, text: `⚠️ Не разобрано сообщений за ${r.window_min} мин: ${n} (порог ${num(t)}). Модель или сеть сбоят.`, ok: `✅ Снова норма: неразобранных за ${r.window_min} мин — ${n}.` };
      }
      case "send_fail": {
        const n = sendFailuresSince(now.getTime() - r.window_min * 60_000);
        const warm = now.getTime() - (this.firstCheckAt ?? now.getTime()) >= r.window_min * 60_000;
        if (!warm && n < t) return { value: null, hit: false, text: "" }; // окно после запуска не набралось — состояние не трогаем
        return { value: n, hit: n >= t, text: `⚠️ Не ушло в Telegram за ${r.window_min} мин: ${n} сообщений (порог ${num(t)}). Бот или сеть сбоят.`, ok: `✅ Снова норма: сбоев отправки в Telegram за ${r.window_min} мин — ${n}.` };
      }
      case "webhook": {
        if (!this.deps.webhookErrorAt) return { value: null, hit: false, text: "" };
        const at = await this.deps.webhookErrorAt();
        const n = at && at >= now.getTime() - r.window_min * 60_000 ? 1 : 0;
        return { value: n, hit: n >= t, text: `⚠️ Telegram не смог доставить сообщения на сервер (вебхук) за последние ${r.window_min} мин. Бот не получает сообщения.`, ok: "✅ Снова норма: Telegram доставляет вебхук." };
      }
      case "signup_cap": {
        const tf = tariffs();
        const hour = await this.store.countUsersSince(iso(now.getTime() - 3600_000));
        const day = await this.store.countUsersSince(iso(now.getTime() - 86_400_000));
        const share = Math.max(hour / tf.signupsPerHour, day / tf.signupsPerDay) * 100;
        return {
          value: share, hit: share >= t,
          text: `⚠️ Регистрации у потолка: за час ${hour} из ${tf.signupsPerHour}, за сутки ${day} из ${tf.signupsPerDay}. Закрыть регистрацию — «Общие потолки» или /signups off.`,
          ok: `✅ Регистрации снова ниже потолка: за час ${hour} из ${tf.signupsPerHour}, за сутки ${day} из ${tf.signupsPerDay}.`,
        };
      }
      case "refund":
      case "payment": {
        const kinds: BillingKind[] = s.id === "refund" ? ["refunded"] : ["paid_first", "paid_once", "renewed"];
        const e = await this.store.billingEventsSince(kinds, r.mark ?? now.toISOString());
        return {
          value: e.n, hit: e.n >= t,
          text: s.id === "refund" ? `↩️ Возвратов звёзд: ${e.n} на ⭐${e.stars}. Подробности — «Оплаты».` : `⭐ Новых оплат: ${e.n} на ⭐${e.stars}. Подробности — «Оплаты».`,
        };
      }
      case "support_new": {
        const n = await this.store.ticketsSince(r.mark ?? now.toISOString());
        return { value: n, hit: n >= t, text: `📨 Новых обращений: ${n}. Ответить — «Обращения» в админке.` };
      }
      case "backup": {
        if (this.store.driver.dialect !== "sqlite") return { value: null, hit: false, text: "" };
        const runs = await this.store.dbCopies("copy", 30);
        if (!runs.length) return { value: null, hit: false, text: "" };
        const last = runs[0];
        const good = runs.find((x) => x.status === "ok" && !x.problem);
        const hours = (now.getTime() - Date.parse((good ?? runs.at(-1)!).at)) / 3600_000;
        const bad = last.status === "fail" || Boolean(last.problem);
        return {
          value: Math.round(hours * 10) / 10, hit: bad || hours >= t,
          text: bad ? `⚠️ Копия базы: ${last.problem}. Последняя удачная — ${good ? `${Math.round(hours)} ч назад` : "ни разу"}. Подробности — «Копии базы».`
            : `⚠️ Копии базы ${Math.round(hours)} ч — новой нет (порог ${num(t)} ч). Подробности — «Копии базы».`,
          ok: "✅ Копия базы снова в порядке: снялась и ушла в Telegram.",
        };
      }
      case "db_size": {
        const b = this.deps.dbBytes?.() ?? null;
        if (b == null) return { value: null, hit: false, text: "" };
        const m = b / 1024 / 1024;
        return { value: Math.round(m), hit: m >= t, text: `⚠️ База выросла до ${Math.round(m)} МБ (порог ${num(t)} МБ). Сжатая копия больше 50 МБ в Telegram не влезет.`, ok: `✅ База снова меньше порога: ${Math.round(m)} МБ.` };
      }
      case "newcomers":
        return { value: null, hit: false, text: "" };
      case "release_crash": {
        const rel = await readRelease(this.store);
        if (!rel?.prev || releaseDone(rel, now)) return { value: null, hit: false, text: "" };
        const c = await releaseCrashes(this.store, rel, now);
        // Сравнивать не с чем (прошлая не шлёт падений, на ней мало людей) — молчим, а не «в бесконечность раз» (releases.ts crashRatio).
        const { x } = crashRatio(c.cur, c.prev);
        if (x == null) return { value: null, hit: false, text: "" };
        const hit = c.cur.crashed >= RELEASE_CRASH_MIN_USERS && x >= t;
        const pct = (v: number) => `${(v * 100).toFixed(1).replace(".", ",")}%`;
        const was = c.prev ? `${pct(c.prevShare)} на ${rel.prev} (${c.prev.crashed} из ${c.prev.active})` : `на ${rel.prev} данных нет`;
        let text = `⚠️ Программа ${rel.version} падает чаще: у ${pct(c.curShare)} людей (${c.cur.crashed} из ${c.cur.active}) против ${was} за ${RELEASE_CRASH_DAYS} дн.`;
        if (hit) {
          const paused = await autoPause(this.store, `падения ${pct(c.curShare)} против ${pct(c.prevShare)} (порог — в ${num(t)} раза)`, now);
          const r2 = await readRelease(this.store);
          text += paused ? " Выпуск поставлен на паузу — новые люди её не получат." : r2?.paused ? " Выпуск на паузе." : " Выпуск идёт (его продолжили вручную).";
          text += " Подробности — «Падения» и «Выпуски».";
        }
        return {
          value: Math.round(x * 100) / 100, hit, text,
          ok: `✅ Падения ${rel.version} снова ниже порога: ${pct(c.curShare)} людей против ${pct(c.prevShare)} на ${rel.prev}. Выпуск сам не продолжается — «Выпуски».`,
        };
      }
    }
  }

  private async say(id: AlertRuleId, kind: string, value: number | null, text: string, now: Date): Promise<boolean> {
    const full = text + this.link();
    const n = await this.deps.notify(full).catch((e) => (console.error("[alerts]", id, e), 0));
    await this.store.addAlertLog({ at: now, rule: id, kind, value, text, sent: n > 0 });
    return n > 0;
  }

  /** Проверить все правила. force — не ждать ALERT_CHECK_MS (кнопка «Проверить сейчас»); антиспам действует всегда.
   *  Две проверки сразу не идут: вторая ждёт первую и возвращает её итог. */
  async check(now = new Date(), force = false): Promise<AlertCheckRow[] | null> {
    if (this.running) return this.running;
    if (!force && now.getTime() - this.lastCheck < ALERT_CHECK_MS) return null;
    this.lastCheck = now.getTime();
    this.firstCheckAt ??= now.getTime();
    this.running = this.checkAll(now).finally(() => (this.running = null));
    return this.running;
  }

  private async checkAll(now: Date): Promise<AlertCheckRow[]> {
    const out: AlertCheckRow[] = [];
    for (const { spec: s, row: r } of await this.rules(now)) {
      try {
        out.push(await this.checkOne(s, r, now));
      } catch (e) {
        console.error("[alerts]", s.id, e);
        out.push({ id: s.id, value: null, hit: false, firing: r.firing, sent: null, enabled: Boolean(r.enabled) });
      }
    }
    return out;
  }

  private async checkOne(s: AlertSpec, r: AlertRuleRow, now: Date): Promise<AlertCheckRow> {
    const row = (value: number | null, hit: boolean, firing: number, sent: AlertCheckRow["sent"]): AlertCheckRow => ({ id: s.id, value, hit, firing, sent, enabled: Boolean(r.enabled) });
    if (!r.enabled) {
      // Выключенное молчит; если было в тревоге — тихо в норму (включат — начнёт с чистого, события — с этого момента).
      if (r.firing || s.kind === "event") await this.store.updateAlertRule(s.id, { firing: 0, ...(s.kind === "event" ? { mark: now.toISOString() } : {}) });
      return row(null, false, 0, null);
    }
    const cool = !r.last_sent || now.getTime() - Date.parse(r.last_sent) >= r.every_min * 60_000;
    if (s.kind === "daily") {
      if (now.getUTCHours() < NEWCOMERS_HOUR_UTC || !(await this.store.once(`digest:${now.toISOString().slice(0, 10)}`))) return row(null, false, 0, null);
      const since = (await this.store.kvGet("newcomers:since")) ?? iso(now.getTime() - 86_400_000);
      const got = await newcomersText(this.store, since);
      if (!got || got.n < r.threshold) {
        await this.store.kvSet("newcomers:since", now.toISOString());
        return row(got?.n ?? 0, false, 0, null);
      }
      // Письмо не дошло (Telegram сбоит) — отметку не двигаем: эти новички войдут в следующую сводку.
      if (!(await this.say(s.id, "fire", got.n, got.text, now))) return row(got.n, true, 0, null);
      await this.store.kvSet("newcomers:since", now.toISOString());
      await this.store.updateAlertRule(s.id, { last_sent: now.toISOString(), last_value: got.n });
      return row(got.n, true, 0, "fire");
    }
    const m = await this.measure(s, r, now);
    if (m.value == null && !m.hit) return row(null, false, r.firing, null);
    if (s.kind === "event") {
      // События копятся с отметки mark: письмо — одно на всё накопленное, не чаще раза в every_min; после письма отметка — сейчас.
      if (!m.hit || !cool) return row(m.value, m.hit, 0, m.hit ? "held" : null);
      // Не дошло никому — mark и last_sent не двигаем: накопленное уйдёт следующей проверкой.
      if (!(await this.say(s.id, "fire", m.value, m.text, now))) return row(m.value, true, 0, null);
      await this.store.updateAlertRule(s.id, { last_sent: now.toISOString(), last_value: m.value, mark: now.toISOString() });
      return row(m.value, true, 0, "fire");
    }
    if (m.hit) {
      if (r.firing === 0 || (cool && r.firing === 1)) {
        // Сработало: письмо, если «не чаще раза в» прошло; иначе — тревога без письма (firing 1), письмо уйдёт, когда срок выйдет.
        if (!cool) {
          await this.store.updateAlertRule(s.id, { firing: 1, last_value: m.value });
          await this.store.addAlertLog({ at: now, rule: s.id, kind: "held", value: m.value, text: m.text, sent: false });
          return row(m.value, true, 1, "held");
        }
        if (!(await this.say(s.id, "fire", m.value, m.text, now))) {
          // Письмо не дошло: тревога без письма (firing 1), last_sent прежний — следующая проверка пробует снова.
          await this.store.updateAlertRule(s.id, { firing: 1, last_value: m.value });
          return row(m.value, true, 1, null);
        }
        await this.store.updateAlertRule(s.id, { firing: 2, last_sent: now.toISOString(), last_value: m.value });
        return row(m.value, true, 2, "fire");
      }
      if (cool) {
        if (!(await this.say(s.id, "repeat", m.value, `🔁 Всё ещё держится. ${m.text}`, now))) {
          await this.store.updateAlertRule(s.id, { last_value: m.value });
          return row(m.value, true, r.firing, null);
        }
        await this.store.updateAlertRule(s.id, { firing: 2, last_sent: now.toISOString(), last_value: m.value });
        return row(m.value, true, 2, "repeat");
      }
      await this.store.updateAlertRule(s.id, { last_value: m.value });
      return row(m.value, true, r.firing, null);
    }
    if (r.firing) {
      // Прошло. «Снова норма» — только если о тревоге писали (firing 2) и у правила это имеет смысл.
      const tell = r.firing === 2 && s.recover && m.ok;
      if (tell) {
        // «Снова норма» не дошло — остаёмся в firing 2: следующая проверка напишет снова.
        if (!(await this.say(s.id, "ok", m.value, m.ok!, now))) return row(m.value, false, r.firing, null);
      } else await this.store.addAlertLog({ at: now, rule: s.id, kind: "ok", value: m.value, text: m.ok ?? "", sent: false });
      await this.store.updateAlertRule(s.id, { firing: 0, last_value: m.value });
      return row(m.value, false, 0, tell ? "ok" : null);
    }
    if (r.last_value !== m.value) await this.store.updateAlertRule(s.id, { last_value: m.value });
    return row(m.value, false, 0, null);
  }

  /** Изменить правило из админки: вкл/выкл, порог, окно, «не чаще раза в»; причина обязательна; в журнал админа — что было и стало. */
  async update(adminId: number, body: unknown, now = new Date()) {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (reason.length < 3) throw new AlertError(400, "напишите причину (хотя бы 3 знака)");
    if (reason.length > 300) throw new AlertError(400, "причина — не длиннее 300 знаков");
    const all = await this.rules(now);
    const it = all.find((x) => x.spec.id === b.id);
    if (!it) throw new AlertError(404, "нет такого правила");
    const { spec: s, row: r } = it;
    const patch: Partial<AlertRuleRow> = {};
    const changes: string[] = [];
    if ("enabled" in b) {
      if (typeof b.enabled !== "boolean") throw new AlertError(400, "вкл — да или нет");
      if (Number(b.enabled) !== r.enabled) { patch.enabled = b.enabled ? 1 : 0; changes.push(b.enabled ? "включено" : "выключено"); }
    }
    const numIn = (k: "threshold" | "window_min" | "every_min", min: number, max: number, int: boolean, what: string) => {
      if (!(k in b)) return;
      const v = b[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
        throw new AlertError(400, `${what}: ${int ? "целое" : "число"} от ${min} до ${max}`);
      }
      const val = int ? v : Math.round(v * 100) / 100;
      if (val !== r[k]) { patch[k] = val; changes.push(`${what} ${num(r[k])} → ${num(val)}`); }
    };
    numIn("threshold", s.min, s.max, s.int, "порог");
    if (s.window) numIn("window_min", 5, 1440, true, "окно, мин");
    else if ("window_min" in b && b.window_min !== r.window_min) throw new AlertError(400, "окно у этого правила не меняется");
    if (s.kind !== "daily") numIn("every_min", 5, 10_080, true, "не чаще, мин");
    if (!changes.length) throw new AlertError(400, "ничего не изменилось");
    await this.store.updateAlertRule(s.id, { ...patch, updated_at: now.toISOString(), updated_by: adminId });
    await this.store.addAdminLog(adminId, "alert_rule", `${s.id}: ${changes.join("; ")}`, now, reason);
    return this.view(now);
  }

  /** Тестовое письмо владельцу: дошло ли (сколько получателей). В журнал админа и в историю оповещений. */
  async test(adminId: number, reason: unknown, now = new Date()) {
    const why = typeof reason === "string" ? reason.trim() : "";
    if (why.length < 3) throw new AlertError(400, "напишите причину (хотя бы 3 знака)");
    const n = await this.deps.notify(`🔔 Проверка оповещений: так горничная напишет, если что-то пойдёт не так.${this.link()}`).catch(() => 0);
    await this.store.addAlertLog({ at: now, rule: "test", kind: "test", value: null, text: "Тестовое оповещение", sent: n > 0 });
    await this.store.addAdminLog(adminId, "alert_test", `получателей: ${n}`, now, why.slice(0, 300));
    return { sent: n };
  }

  /** «Проверить сейчас»: все правила без ожидания такта; в журнал админа — сколько сработало. */
  async checkNow(adminId: number, reason: unknown, now = new Date()) {
    const why = typeof reason === "string" ? reason.trim() : "";
    if (why.length < 3) throw new AlertError(400, "напишите причину (хотя бы 3 знака)");
    const rows = (await this.check(now, true)) ?? [];
    const sent = rows.filter((x) => x.sent && x.sent !== "held").length;
    await this.store.addAdminLog(adminId, "alert_check", `тревог: ${rows.filter((x) => x.hit).length}, писем: ${sent}`, now, why.slice(0, 300));
    return { results: rows, ...(await this.view(now)) };
  }

  /** Раздел «Оповещения»: правила (подписи, единицы, границы, состояние) и последние срабатывания. Только числа. */
  async view(now = new Date()) {
    const rules = (await this.rules(now)).map(({ spec: s, row: r }) => ({
      id: s.id, title: s.title, unit: s.unit, kind: s.kind, hint: s.hint, recover: s.recover, window: s.window, min: s.min, max: s.max, int: s.int,
      enabled: Boolean(r.enabled), threshold: r.threshold, window_min: r.window_min, every_min: r.every_min,
      firing: r.firing, last_sent: r.last_sent, last_value: r.last_value, updated_at: r.updated_at,
    }));
    return { check_every_min: ALERT_CHECK_MS / 60_000, rules, history: await this.store.alertLog(50) };
  }
}
