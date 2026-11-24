// Админка сайта (/admin) без React: разделы и подписи журнала. Ревью — docs/review/админка-2026-11-24.html.
// Каркас (24.11.2026): Обзор и Журнал; этап 1 (24.11.2026): Пользователи, Расходы, Аудитория, Качество разбора — на готовых данных.
// Этап 2 (24.11.2026): онлайн, устройства, карта часов, версии виджета, дорогие сообщения и раздел «Здоровье сервера».
// Этап 3 (24.11.2026): «Использование функций» — счётчики фич (server/src/feature-events.ts, отчёт — admin-stats.ts adminFeatures).
// Этап 4 (24.11.2026): «Витрина» — анимации с проигрывателем, эффекты, сценарии, карта функций (screens/AdminShowcase.tsx,
// реестр web/src/registry.gen.ts пишет tools/registry/make_registry.ts).
// Тарифы (24.11.2026): «Тарифы» и «Общие потолки» — числа платного доступа из базы (web/src/tariffs.ts, screens/AdminTariffs.tsx).
// Этап 5 (24.11.2026): Аналитика — отчёты с шагом и сравнением с прошлым периодом (screens/AdminAnalytics.tsx, графики — adminCharts.tsx,
// ручка GET /api/admin/analytics — server/src/admin-analytics.ts; типы ниже — копия оттуда один в один).
// Этап 3 «Тарифы и управление» (24.11.2026): «Аккаунт» — карточка по номеру и действия с причиной (screens/AdminAccount.tsx,
// сервер — server/src/admin-account.ts); журнал админа — номера вместо имён, параметры и причина.
// Этап 4 «Тарифы и управление» (24.11.2026): «Оповещения» — правила по порогам владельцу в Telegram (server/src/alerts.ts) и
// «Копии базы» — ночная копия, отправка в Telegram, проверка восстановления (server/src/snapshot.ts DbCopies); screens/AdminAlerts.tsx.
// Этап 5 «Тарифы и управление» (24.11.2026): «Выпуски» — поэтапный выпуск программы на ПК (server/src/releases.ts) и «Падения» —
// падения программы по версиям и местам (server/src/crashes.ts); screens/AdminReleases.tsx.
// Этап 6 «Тарифы и управление» (24.11.2026): «Переключатели» (server/src/switches.ts), «Промокоды» (promo.ts), «Обращения»
// (support.ts), «Объявления» (announce.ts), «Прогноз» (prognosis.ts); screens/AdminManage.tsx. Новая категория «Связь с людьми».
// stage — с какого этапа раздел живой (ADMIN_LIVE_STAGE и меньше — живой, больше — «появится на этапе N»).

export const ADMIN_LIVE_STAGE = 5;

export type AdminSectionId = "overview" | "analytics" | "users" | "account" | "payments" | "tariffs" | "caps" | "promo" | "prognosis" | "spend" | "audience" | "quality" | "features" | "switches" | "showcase" | "tickets" | "news" | "health" | "alerts" | "releases" | "crashes" | "backups" | "log";

// Меню по категориям (24.11.2026): group — заголовок категории (ADMIN_GROUPS, по порядку), icon — имя в icons.tsx.
export const ADMIN_GROUPS = ["Обзор", "Люди и деньги", "ИИ", "Продукт", "Связь с людьми", "Система"] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

export const ADMIN_SECTIONS: { id: AdminSectionId; title: string; stage: number; group: AdminGroup; icon: string }[] = [
  { id: "overview", title: "Обзор", stage: 0, group: "Обзор", icon: "adm-home" },
  { id: "analytics", title: "Аналитика", stage: 5, group: "Обзор", icon: "adm-chart" },
  { id: "users", title: "Пользователи", stage: 1, group: "Люди и деньги", icon: "adm-users" },
  // Аккаунт по номеру (этап 3 «Тарифы и управление», screens/AdminAccount.tsx): /admin/account/<номер>.
  { id: "account", title: "Аккаунт", stage: 0, group: "Люди и деньги", icon: "adm-id" },
  { id: "payments", title: "Оплаты", stage: 0, group: "Люди и деньги", icon: "adm-star" },
  // Тарифы из базы (24.11.2026, screens/AdminTariffs.tsx): рядом с оплатами — это те же деньги; отдельная категория из двух пунктов
  // только раздула бы меню, а лимиты в штуках (этап 2) лягут в эти же два раздела.
  { id: "tariffs", title: "Тарифы", stage: 0, group: "Люди и деньги", icon: "adm-tag" },
  { id: "caps", title: "Общие потолки", stage: 0, group: "Люди и деньги", icon: "adm-gauge" },
  // Этап 6: промокоды дарят дни — рядом с тарифами; прогноз денег и расходов — рядом с ними же (в макете — «Деньги»).
  { id: "promo", title: "Промокоды", stage: 0, group: "Люди и деньги", icon: "adm-gift" },
  { id: "prognosis", title: "Прогноз", stage: 0, group: "Люди и деньги", icon: "adm-trend" },
  { id: "audience", title: "Аудитория", stage: 1, group: "Люди и деньги", icon: "adm-target" },
  { id: "spend", title: "Расходы на модель", stage: 1, group: "ИИ", icon: "adm-coins" },
  { id: "quality", title: "Качество разбора", stage: 1, group: "ИИ", icon: "adm-check" },
  { id: "features", title: "Использование функций", stage: 3, group: "Продукт", icon: "adm-spark" },
  { id: "switches", title: "Переключатели", stage: 0, group: "Продукт", icon: "adm-toggle" },
  { id: "showcase", title: "Витрина", stage: 4, group: "Продукт", icon: "adm-grid" },
  // Этап 6: связь с людьми — обращения и объявления.
  { id: "tickets", title: "Обращения", stage: 0, group: "Связь с людьми", icon: "adm-chat" },
  { id: "news", title: "Объявления", stage: 0, group: "Связь с людьми", icon: "adm-megaphone" },
  { id: "health", title: "Здоровье сервера", stage: 2, group: "Система", icon: "adm-pulse" },
  // Этап 4 «Тарифы и управление»: в «Системе» — рядом со здоровьем сервера, о котором оповещения и пишут.
  { id: "alerts", title: "Оповещения", stage: 0, group: "Система", icon: "adm-bell" },
  // Этап 5: выпуск и падения программы на ПК — рядом с оповещениями (автопауза — их правило release_crash).
  { id: "releases", title: "Выпуски", stage: 0, group: "Система", icon: "adm-rocket" },
  { id: "crashes", title: "Падения", stage: 0, group: "Система", icon: "adm-bug" },
  { id: "backups", title: "Копии базы", stage: 0, group: "Система", icon: "adm-db" },
  { id: "log", title: "Журнал админки", stage: 0, group: "Система", icon: "adm-log" },
];

/** Меню админки: категории по порядку ADMIN_GROUPS, внутри — разделы в порядке ADMIN_SECTIONS. Пустые категории не показываются. */
export function adminNavGroups() {
  return ADMIN_GROUPS.map((group) => ({ group, items: ADMIN_SECTIONS.filter((s) => s.group === group) })).filter((g) => g.items.length);
}

/** Раздел по адресу /admin/<раздел>; незнакомый и пустой — Обзор. */
export function adminSection(arg: string | undefined): AdminSectionId {
  return ADMIN_SECTIONS.find((s) => s.id === arg)?.id ?? "overview";
}

export const ADMIN_ACTIONS: Record<string, string> = {
  code: "запросил код в Telegram",
  enter: "вошёл в админку",
  wrong: "ввёл неверный код",
  leave: "вышел из админки",
  refund: "вернул звёзды",
  "refund-fail": "не смог вернуть звёзды",
  tariff: "изменил тарифы",
  tariff_undo: "вернул тарифы как было",
  extend: "продлил срок",
  grant: "выдал подарок",
  bonus: "поднял лимит на сегодня",
  freeze: "заморозил аккаунт",
  unfreeze: "разморозил аккаунт",
  "paysupport-answer": "ответил на вопрос об оплате",
  alert_rule: "изменил правило оповещений",
  alert_test: "отправил тестовое оповещение",
  alert_check: "проверил оповещения вручную",
  backup_run: "сделал копию базы",
  backup_verify: "проверил восстановление копии",
  release_start: "начал выпуск новой версии",
  release_percent: "изменил долю выпуска",
  release_pause: "поставил выпуск на паузу",
  release_resume: "продолжил выпуск",
  release_autopause: "поставил выпуск на паузу из-за падений",
  switch_on: "включил функцию",
  switch_off: "выключил функцию",
  promo_create: "создал промокод",
  promo_on: "включил промокод",
  promo_off: "выключил промокод",
  ticket_status: "сменил статус обращения",
  ticket_answer: "ответил на обращение",
  announce_create: "опубликовал объявление",
  announce_on: "включил объявление",
  announce_off: "выключил объявление",
};

// ——— Выпуски и падения (этап 5; типы — копия server/src/releases.ts releasesView и server/src/crashes.ts adminCrashes).
export interface ReleaseInfo {
  version: string; percent: number; paused: boolean; started_at: string; prev: string; auto_paused_at: string | null; updated_at: string; by: number;
}
export interface ReleasesData {
  release: ReleaseInfo | null; file_version: string | null; served: number | null; start_percent: number; min_users: number; crash_days: number;
  versions: { version: string; active: number; share_people: number; crashed: number; crash_share: number }[];
  crash: { version: string; active: number; crashed: number; share: number; prev: { version: string; active: number; crashed: number; share: number } | null } | null;
}
export interface CrashPlace { process: string; kind: string; place: string; fingerprint: string; count: number; users: number; first: string; last: string; fresh: boolean }
export interface CrashVersion {
  version: string; active: number; crashed: number; crashes: number; share: number;
  prev: { version: string; active: number; crashed: number; share: number } | null; top: CrashPlace[];
}
export interface CrashesData { days: number; from: string; versions: CrashVersion[]; series: { day: string; active: number; crashed: number; crashes: number }[]; keep_days: number }

/** Процессы программы (server/src/crashes.ts CRASH_PROCESSES) по-человечески. */
export const CRASH_PROCESS_NAMES: Record<string, string> = {
  main: "главный процесс", widget: "виджет", quick: "быстрая запись", window: "главное окно", gpu: "видеочасть", utility: "служебный", child: "другой процесс",
};

/** Копии server/src/releases.ts: сравнение с прошлой — только если на ней не меньше стольких людей и она шлёт падения (не старше). */
export const RELEASE_CRASH_MIN_PREV = 20;
export const CRASH_FIRST_VERSION = "0.1.93";
const olderVersion = (a: string, b: string) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};

/** Сравнение доли падений с прошлой версией: «в 3,0 раза чаще», «реже», «как у прошлой», «прошлой нет». Как автопауза на сервере
 *  (releases.ts crashRatio): прошлая не шлёт падений или на ней меньше RELEASE_CRASH_MIN_PREV людей — не сравнивается; у прошлой
 *  0 падений — её доля берётся не ниже 1/людей. */
export function crashCompare(cur: { share: number; active: number }, prev: { share: number; active: number; version?: string } | null): { text: string; tone: "bad" | "warn" | "ok" | "mute" } {
  if (!prev || !prev.active) return { text: "прошлой версии нет", tone: "mute" };
  if (prev.version && olderVersion(prev.version, CRASH_FIRST_VERSION)) return { text: "прошлая версия падений не присылает", tone: "mute" };
  if (prev.active < RELEASE_CRASH_MIN_PREV) return { text: `на прошлой мало людей (${prev.active}) — не сравнить`, tone: "mute" };
  if (!cur.active) return { text: "людей ещё нет", tone: "mute" };
  const x = cur.share / Math.max(prev.share, 1 / prev.active);
  if (prev.share === 0) return cur.share === 0 ? { text: "падений нет, как и у прошлой", tone: "ok" } : { text: "у прошлой падений не было", tone: x >= 2 ? "bad" : "warn" };
  if (x >= 2) return { text: `в ${x.toFixed(1).replace(".", ",")} раза чаще прошлой`, tone: "bad" };
  if (x > 1.2) return { text: `чаще прошлой (×${x.toFixed(1).replace(".", ",")})`, tone: "warn" };
  if (x < 0.8) return { text: "реже прошлой", tone: "ok" };
  return { text: "как у прошлой", tone: "ok" };
}

/** Состояние выпуска одной фразой: «на паузе (автопауза)», «идёт: 20%», «всем». */
export function releaseState(r: Pick<ReleaseInfo, "paused" | "percent" | "auto_paused_at"> | null): { text: string; tone: "bad" | "warn" | "ok" | "mute" } {
  if (!r) return { text: "выпусков ещё не было", tone: "mute" };
  if (r.paused) return { text: r.auto_paused_at ? "на паузе — сработала автопауза" : "на паузе", tone: "bad" };
  if (r.percent >= 100) return { text: "всем", tone: "ok" };
  return { text: `идёт: ${r.percent}% людей`, tone: "warn" };
}

/** Проверка процента в поле: null — подходит (целое 1…100), иначе почему нет. */
export function percentError(text: string): string | null {
  const v = Number(text.trim());
  if (!text.trim() || !Number.isFinite(v)) return "нужно число";
  if (!Number.isInteger(v)) return "целое число";
  if (v < 1 || v > 100) return "от 1 до 100";
  return null;
}

// ——— Этап 6 (типы — копия server/src/switches.ts switchesView, promo.ts promoView, support.ts ticketsView и ticketCard,
// announce.ts announcementsView, prognosis.ts prognosisView).
export interface SwitchInfo { id: string; title: string; hint: string; off_text: string; on: boolean; updated_at: string | null; updated_by: string | null }
export interface SwitchesData { reload_ms: number; env_closed: boolean; switches: SwitchInfo[] }

export type PromoState = "on" | "off" | "ended" | "empty";
export interface PromoCode { id: number; code: string; days: number; used: number; max_uses: number; ends_at: string | null; created_at: string; created_by: string; state: PromoState }
export interface PromoData { days_max: number; uses_max: number; tries: number; window_min: number; codes: PromoCode[] }
/** Состояние кода одной фразой и тоном. */
export function promoStateText(s: PromoState): { text: string; tone: "ok" | "mute" | "warn" } {
  return s === "on" ? { text: "работает", tone: "ok" } : s === "empty" ? { text: "кончился", tone: "mute" } : s === "ended" ? { text: "срок вышел", tone: "mute" } : { text: "выключен", tone: "warn" };
}
/** Проверка своего кода в поле (как на сервере promo.ts PROMO_RE): null — годится. Пусто — значит «сгенерировать». */
export function promoCodeError(code: string): string | null {
  const c = code.trim().toUpperCase();
  if (!c) return null;
  return /^[A-Z0-9-]{4,20}$/.test(c) ? null : "латиница, цифры и дефис, 4–20 знаков";
}

export type TicketStatus = "new" | "work" | "closed";
export const TICKET_STATUS_NAMES: Record<TicketStatus, string> = { new: "новое", work: "в работе", closed: "закрыто" };
export interface TicketRow { id: number; account: string; user_id: number; topic: string; status: TicketStatus; created_at: string; updated_at: string; answered: boolean }
export interface TicketsData {
  per_day: number; topics: Record<string, string>;
  counts: { new: number; work: number; week: number; oldest_open: string | null; answer_hours: number | null };
  tickets: TicketRow[];
}
export interface TicketCard {
  id: number; account: string; user_id: number; topic: string; status: TicketStatus; text: string; answer: string | null;
  created_at: string; updated_at: string; answered_at: string | null; plan: string | null; telegram: boolean;
  /** Только в ответе на «Ответить»: куда ответ ушёл на деле (server/src/support.ts TicketDelivery). */
  delivered?: TicketDelivery;
}
export type TicketDelivery = "telegram" | "feed" | "feed_tg_failed";
/** Что показать админу после «Ответить»: куда ответ на деле дошёл. */
export function ticketAnswerText(d: TicketDelivery | undefined): string {
  return d === "telegram" ? "Ответ ушёл в Telegram и в уведомления."
    : d === "feed_tg_failed" ? "Telegram не принял ответ — он только в уведомлениях; обращение осталось «в работе»."
      : "Ответ ушёл в уведомления.";
}
/** Сколько ждёт: «5 мин», «3 ч», «2 д»; нет — «—». */
export function waitText(iso: string | null, now = new Date()): string {
  if (!iso) return "—";
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m} мин` : m < 48 * 60 ? `${Math.round(m / 60)} ч` : `${Math.round(m / 1440)} д`;
}

export type NewsAudience = "all" | "trial" | "paid";
export interface NewsItem { id: number; text: string; audience: NewsAudience; site: boolean; widget: boolean; enabled: boolean; ends_at: string | null; live: boolean; created_at: string; created_by: string; widget_got: number }
export interface NewsData { text_max: number; audiences: Record<NewsAudience, string>; cache_ms: number; people: Record<NewsAudience, number>; items: NewsItem[] }
/** Проверка текста объявления (как на сервере announce.ts announceTextError): null — годится. */
export function newsTextError(v: string, max = 200): string | null {
  if (!v.trim()) return "напишите текст";
  if (v.trim().length > max) return `не длиннее ${max} знаков`;
  if (/[<>]/.test(v)) return "без знаков < и >";
  // eslint-disable-next-line no-control-regex -- управляющие знаки и есть то, что ищем
  if (/[\u0000-\u001f\u007f]/.test(v)) return "одной строкой";
  return null;
}
/** Объявление в виджете начинается так (server/src/announce.ts ANNOUNCE_PREFIX). */
export const NEWS_PREFIX = "📢 ";

/** data_days — сколько дней с первого дня с данными (среднее делится на них, а не на 7 или 30). */
export interface PrognosisPair { by7: number; by30: number; data_days?: number }
export interface PrognosisData {
  days: number; star_usd: number;
  /** Меньше стольких дней с данными — без прямой и дней до потолка (server/src/prognosis.ts PROGNOSIS_MIN_DAYS). */
  min_days: number;
  spend: { month: PrognosisPair; today: number; data_days: number; slope_per_day: number; trend_last: number; alert_cap: number; days_to_alert: number | null };
  trial_pool: { cap: number; today: number; data_days: number; slope_per_day: number; trend_last: number; days_to_cap: number | null };
  income: { stars: PrognosisPair; usd: PrognosisPair };
  renewals: { n: number; stars: number; usd: number; ending_without_renew: number; by_day: { day: string; n: number; stars: number }[] };
  series: { day: string; cost: number; trial: number; stars: number }[];
}
/** Мало дней с данными — «мало данных: N дн.», иначе null. */
export function fewDataText(dataDays: number | undefined, min: number): string | null {
  return dataDays != null && dataDays < min ? `мало данных: ${dataDays} дн.` : null;
}
/** Подпись плитки роста расхода по знаку: растёт или снижается (значение — без минуса). */
export const growTitle = (slope: number): string => (slope >= 0 ? "Расход за день растёт на" : "Расход за день снижается на");
/** Дни до потолка словами: null — «не упрёмся при нынешнем темпе», 0 — «уже», иначе «через N дн.». */
export function capDaysText(d: number | null): string {
  return d == null ? "не упрёмся при нынешнем темпе" : d === 0 ? "уже на потолке" : `через ${d} дн.`;
}

// ——— Оповещения (этап 4, GET /api/admin/alerts; типы — копия server/src/alerts.ts Alerts.view).
export interface AlertRule {
  id: string; title: string; unit: string; kind: "state" | "event" | "daily"; hint: string; recover: boolean; window: boolean;
  min: number; max: number; int: boolean; enabled: boolean; threshold: number; window_min: number; every_min: number;
  /** 0 — норма, 1 — сработало, письмо придержано антиспамом, 2 — сработало, письмо ушло. */
  firing: number; last_sent: string | null; last_value: number | null; updated_at: string;
}
export interface AlertLogRow { at: string; rule: string; kind: string; value: number | null; text: string; sent: boolean }
export interface AlertsData { check_every_min: number; rules: AlertRule[]; history: AlertLogRow[] }

/** Что было в истории оповещений (alert_log.kind). */
export const ALERT_LOG_KINDS: Record<string, string> = {
  fire: "сработало", repeat: "всё ещё", ok: "снова норма", held: "придержано антиспамом", test: "тест",
};

/** Состояние правила одной фразой: «тревога», «тревога, письмо придержано», «норма», «выключено». */
export function alertState(r: Pick<AlertRule, "enabled" | "firing">): { text: string; tone: "bad" | "warn" | "ok" | "mute" } {
  if (!r.enabled) return { text: "выключено", tone: "mute" };
  if (r.firing === 2) return { text: "тревога", tone: "bad" };
  if (r.firing === 1) return { text: "тревога, письмо придержано", tone: "warn" };
  return { text: "норма", tone: "ok" };
}

/** Последнее измеренное значение с единицей правила: «$4.20», «12%», «3 шт.»; нет — «—». */
export function alertValueText(r: Pick<AlertRule, "unit" | "last_value">): string {
  const v = r.last_value;
  if (v == null) return "—";
  if (r.unit === "$") return `$${v.toFixed(2)}`;
  const n = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return r.unit === "%" ? `${n}%` : `${n} ${r.unit}`;
}

/** Проверка порога в поле: null — подходит, иначе почему нет (те же границы, что на сервере). */
export function alertThresholdError(r: Pick<AlertRule, "min" | "max" | "int">, text: string): string | null {
  const v = Number(text.replace(",", "."));
  if (!text.trim() || !Number.isFinite(v)) return "нужно число";
  if (r.int && !Number.isInteger(v)) return "целое число";
  if (v < r.min || v > r.max) return `от ${r.min} до ${r.max}`;
  return null;
}

// ——— Копии базы (этап 4, GET /api/admin/backups; типы — копия server/src/snapshot.ts DbCopies.view).
export interface DbCopy {
  at: string; kind: "copy" | "verify"; status: "ok" | "fail" | "skip" | "warn"; file: string; bytes: number; gz_bytes: number;
  sent: number; problem: string; note: string; by_user: number; ms: number;
}
export interface BackupsData {
  mode: "sqlite" | "postgres" | "off"; at: string; keep: number; telegram: boolean; max_send_bytes: number; db_bytes: number | null;
  local: { file: string; bytes: number; at: string }[]; copies: DbCopy[]; verifies: DbCopy[];
}

/** Размер: «512 Б», «3,4 КБ», «12,3 МБ», «184 МБ». */
export function bytesText(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} Б`;
  const [v, u] = n < 1024 * 1024 ? [n / 1024, "КБ"] : n < 1024 ** 3 ? [n / 1024 / 1024, "МБ"] : [n / 1024 ** 3, "ГБ"];
  return `${v.toFixed(v < 10 ? 1 : 0).replace(".", ",")} ${u}`;
}

/** Итог копии или проверки одной фразой и тоном. */
export function copyStatus(c: Pick<DbCopy, "kind" | "status" | "problem" | "sent">): { text: string; tone: "bad" | "warn" | "ok" | "mute" } {
  if (c.status === "skip") return { text: "пропущено", tone: "mute" };
  if (c.status === "fail") return { text: c.kind === "verify" ? "не поднимается" : "не снялась", tone: "bad" };
  if (c.status === "warn") return { text: "поднимается, числа расходятся", tone: "warn" };
  if (c.kind === "verify") return { text: "поднимается", tone: "ok" };
  if (c.problem) return { text: "на сервере, в Telegram не ушла", tone: "warn" };
  return { text: c.sent ? "на сервере и в Telegram" : "только на сервере", tone: c.sent ? "ok" : "warn" };
}

// ——— Аккаунт по номеру (этап 3, GET /api/admin/account/<id>; типы — копия server/src/admin-account.ts accountCard).
export type AccountPlan = "owner" | "friend" | "paid" | "trial" | "expired" | "frozen";
export interface AccountUsed { used: number; limit: number; bonus: number }
export interface AccountCard {
  id: number; created_at: string; days_with_us: number;
  plan: AccountPlan; kind: "trial" | "gift" | "paid" | null; until: string | null; canceled: boolean;
  live_sub: boolean; frozen_at: string | null; protected: boolean; ended: "trial" | "gift" | "paid" | null;
  today: { day: string; resets_at: string; calls: AccountUsed; draws: AccountUsed; voice_sec: AccountUsed; spend_usd: number; cap_usd: number } | null;
  payments: { charge: string; amount: number; currency: string; kind: string; paid_at: string; expires_at: string | null; refunded_at: string | null; refundable: boolean }[];
  events: { at: string; kind: string; amount: number | null }[];
  week: { day: string; ai: number; manual: number; minutes: number; calls: number; usd: number }[];
  devices: { client: string; version: string; last_seen: string; count: number }[];
  last_seen: string | null;
  log: { at: string; who: string; action: string; detail: string; reason: string }[];
}

/** Номер аккаунта из адреса /admin/account/<номер> (нет или не число — null). */
export function accountIdOf(path: string): number | null {
  const m = /^\/admin\/account\/#?(\d{1,12})\/?$/.exec(path);
  return m ? Number(m[1]) : null;
}
/** Номер из поля «Найти»: «1042», «#1042» — 1042; иначе null. */
export function accountQuery(q: string): number | null {
  const m = /^\s*#?(\d{1,12})\s*$/.exec(q);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : null;
}

/** Журнал подписки (billing_events.kind, server/src/db.ts BILLING_KINDS) по-человечески. */
export const BILLING_EVENT_NAMES: Record<string, string> = {
  paid_first: "Первая оплата подписки", paid_once: "Разовая оплата", renewed: "Продление", canceled: "Отменил продление", resumed: "Возобновил продление",
  refunded: "Возврат звёзд", expired: "Подписка кончилась", trial_ended: "Проба кончилась", gift_ended: "Подарок кончился",
  trial_started: "Проба при регистрации", gift: "Подарок по приглашению", admin_extend: "Админ продлил срок", admin_grant: "Админ выдал подарок",
};

/** Тариф в карточке: «Подписка до 01.12.2026», «Подарок до …», «Проба до …», «Друг», «Заморожен», «Срок кончился (подписка)». */
export function accountPlanText(c: Pick<AccountCard, "plan" | "kind" | "until" | "canceled" | "ended">): string {
  const until = c.until ? new Date(c.until).toLocaleDateString("ru-RU") : "—";
  if (c.plan === "owner") return "Владелец — без сроков и лимитов";
  if (c.plan === "friend") return "Друг — бесплатно навсегда";
  if (c.plan === "frozen") return "Заморожен";
  if (c.plan === "paid") return `Подписка до ${until}${c.canceled ? " (продление отменено)" : ""}`;
  if (c.plan === "trial") return `${c.kind === "gift" ? "Подарок" : "Проба"} до ${until}`;
  return `Срок кончился${c.ended ? ` (${c.ended === "paid" ? "подписка" : c.ended === "gift" ? "подарок" : "проба"})` : ""}${c.until ? `, ${until}` : ""}`;
}

/** «Сегодня» в карточке: «37 из 400 (+20)»; голос — в минутах. */
export function usedText(u: AccountUsed, voice = false): string {
  const k = (n: number) => (voice ? Math.floor(n / 60) : n);
  return `${k(u.used)} из ${k(u.limit)}${u.bonus ? ` (+${k(u.bonus)})` : ""}${voice ? " мин" : ""}`;
}

/** Что можно сделать с аккаунтом (кнопки карточки): продлить и подарить — не другу, не владельцу и не замороженному (сначала
 *  разморозить); подарок — не поверх идущей оплаченной подписки (и с отменённым продлением тоже); лимит — только с тарифом;
 *  заморозить — не защищённого и не уже замороженного. Сервер проверяет то же самое. */
export function accountCan(c: Pick<AccountCard, "plan" | "kind" | "live_sub" | "frozen_at" | "protected">) {
  const free = c.plan === "owner" || c.plan === "friend" || c.protected;
  return {
    extend: !free && !c.frozen_at,
    grant: !free && !c.frozen_at && !c.live_sub && c.plan !== "paid",
    bonus: Boolean(c.kind),
    freeze: !c.protected && !c.frozen_at,
    unfreeze: Boolean(c.frozen_at),
  };
}

// ——— Оплаты (24.11.2026, подписка Telegram Stars: server/src/billing.ts, отчёт — admin-stats.ts adminPayments).
export type PaymentRow = {
  user_id: number; name: string; amount: number; currency: string; kind: string;
  paid_at: string; expires_at: string | null; refunded_at: string | null; charge: string;
};

/** Вид оплаты (payments.kind): первая оплата подписки, продление, разовая. */
export const PAYMENT_KINDS: Record<string, string> = { first: "Подписка", renew: "Продление", once: "Разовая" };

/** Сумма: звёзды — «⭐150», другая валюта — «150 USD». */
export function starsText(amount: number, currency = "XTR"): string {
  return currency === "XTR" ? `⭐${amount}` : `${amount} ${currency}`;
}

/** Можно ли вернуть оплату кнопкой: не возвращена и это последняя невозвращённая у человека (сервер возвращает именно её,
 *  billing.ts refund). rows — новые сверху, как отдаёт /api/admin/payments. */
export function refundable(rows: PaymentRow[], i: number): boolean {
  const p = rows[i];
  if (!p || p.refunded_at) return false;
  return rows.findIndex((x) => x.user_id === p.user_id && !x.refunded_at) === i;
}

/** Деньги: $0.123 → «$0.12», мелочь — с тремя знаками, ноль — «$0». */
export function usd(v: number): string {
  if (!v) return "$0";
  return v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

/** «Когда»: сегодня — время, вчера — «вчера», раньше — «N дн. назад», больше месяца — дата. */
export function ago(iso: string | null, now = new Date()): string {
  if (!iso) return "—";
  const d = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (d === 1) return "вчера";
  if (d < 31) return `${d} дн. назад`;
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

/** Источник сообщения по-человечески. */
export const SOURCE_NAMES: Record<string, string> = {
  telegram: "Telegram", desktop: "Сайт и виджет", app: "Приложение", iphone: "Айфон", button: "Кнопки", push: "Push", panel: "Правки мышью",
};

/** Клиент входа (заголовок X-Maid-Client; у старых — по метке входа, server/src/auth.ts). */
export const CLIENT_NAMES: Record<string, string> = {
  web: "Сайт", desktop: "Программа на ПК", "desktop-key": "Ключ ПК (сервер)", widget: "Виджет на ПК", quick: "Быстрая запись", iphone: "Айфон",
  "telegram-widget": "Виджет Telegram", telegram: "Telegram", push: "Push-уведомления", other: "Другое",
};

/** Ветка разбора сообщения (messages.route, server/src/pipeline.ts). */
export const ROUTE_NAMES: Record<string, string> = {
  weather: "Погода", chat: "Разговор", parse: "Разбор упал", clarify: "Уточнение", draw: "Рисование", answer: "Ответ на вопрос",
  talk: "Болтовня", apply: "Запись", correct: "Поправка",
};

/** Код ошибки попытки модели (llm_calls.error_code, server/src/llm.ts). */
export const ERROR_NAMES: Record<string, string> = {
  timeout: "Тайм-аут", net: "Нет сети", http_429: "Лимит (429)", http_5xx: "Сбой провайдера (5xx)", http_4xx: "Отказ (4xx)",
  bad_body: "Плохой ответ", empty: "Пустой ответ", no_key: "Нет ключа", other: "Другое",
};

/** Дни недели карты часов (строки — с понедельника). */
export const ADM_WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** Время ответа: 840 → «840 мс», 12 300 → «12.3 с»; нет данных — «—». */
export function msText(v: number | null): string {
  if (v == null) return "—";
  return v < 1000 ? `${Math.round(v)} мс` : `${(v / 1000).toFixed(1)} с`;
}

/** Сколько работает сервер: «45 с», «12 мин», «3 ч 5 мин», «2 дн. 4 ч». */
export function uptimeText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (h < 1) return `${m} мин`;
  if (d < 1) return `${h} ч ${m % 60} мин`;
  return `${d} дн. ${h % 24} ч`;
}

/** Сортировка таблицы людей: по ключу, числа — по убыванию, строки — по алфавиту; повторный щелчок — наоборот. */
export function sortRows<T extends Record<string, unknown>>(rows: T[], key: keyof T, desc: boolean): T[] {
  const k = (r: T) => r[key] ?? "";
  return [...rows].sort((a, b) => {
    const x = k(a), y = k(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru");
    return desc ? -c : c;
  });
}

// ——— Этап 3: использование функций (/api/admin/features).
export type FeatureStat = { uses30: number; people30: number; weeks: number[]; last: string | null };
export type FeatureRow = { id: string; title: string; group: string; by: "client" | "server"; all: FeatureStat; clients: Record<string, FeatureStat> };
export const FEATURE_WEEKS = 8;
const noStat = (): FeatureStat => ({ uses30: 0, people30: 0, weeks: Array<number>(FEATURE_WEEKS).fill(0), last: null });

/** Строки под фильтр: группа и клиент («all» — все); у строки — счёт выбранного клиента и плоские поля для сортировки. */
export function featureView(rows: FeatureRow[], group: string, client: string) {
  return rows.filter((r) => group === "all" || r.group === group).map((r) => {
    const s = client === "all" ? r.all : r.clients[client] ?? noStat();
    return { id: r.id, title: r.title, group: r.group, by: r.by, uses30: s.uses30, people30: s.people30, weeks: s.weeks,
      trend: s.weeks.reduce((a, b) => a + b, 0), last: s.last ?? "" };
  });
}

/** Линия тренда по неделям в прямоугольнике w×h (точки для <polyline>); всё по нулям — линия по низу. */
export function sparkPoints(weeks: number[], w: number, h: number): string {
  const max = Math.max(1, ...weeks);
  const step = weeks.length > 1 ? w / (weeks.length - 1) : 0;
  return weeks.map((v, i) => `${+(i * step).toFixed(1)},${+(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(" ");
}

/** День последнего использования (ГГГГ-ММ-ДД, по поясу человека) относительно «сегодня» админки. */
export function dayAgo(day: string | null, today: string): string {
  if (!day) return "никогда";
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  if (d <= 0) return "сегодня";
  if (d === 1) return "вчера";
  if (d < 31) return `${d} дн. назад`;
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

// ——— Этап 5: Аналитика (/api/admin/analytics). Типы — копия server/src/admin-analytics.ts (контракт этапа 1 аналитики).
export type AnalyticsReportId = "money" | "subs" | "ai" | "act" | "ret" | "feat" | "parse";
export type AnalyticsStep = "h" | "d" | "w";
export type AnalyticsDays = 1 | 7 | 30 | 90 | 365;
export const ANALYTICS_DAYS: AnalyticsDays[] = [1, 7, 30, 90, 365];
/** cur — текущий период, prev — прошлый той же длины (для стрелки). null — «—». */
export type Pair = { cur: number | null; prev: number | null };
export type AnalyticsNote = "hour_from_calls" | "no_hourly_features" | "days_for_hours" | "latency_30d_only" | "prev_before_data";

export interface AnalyticsBucket {
  /** d: "ГГГГ-ММ-ДД"; w: первый день корзины "ГГГГ-ММ-ДД"; h: начало часа ISO UTC "2026-11-24T13:00:00.000Z". */
  key: string;
  /** d и w: дни включительно (from == to у d); h: ISO [from, to). */
  from: string; to: string;
  /** Сколько дней в корзине: d — 1, h — 1/24, w — 1..7 (первая бывает неполной). */
  days: number;
}
export interface AnalyticsMeta {
  report: AnalyticsReportId; days: AnalyticsDays; step: AnalyticsStep;
  generated_at: string; cached: boolean;
  /** Как разложены дни: "user" — по поясу человека, "utc" — деньги. */
  zone: "user" | "utc";
  /** Последний день периода (сегодня по поясу сервера или UTC — по zone). */
  today: string;
  period: { from: string; to: string };
  prev: { from: string; to: string };
  buckets: AnalyticsBucket[];
  /** Корзины прошлого периода (та же длина; ряды prev_* — по ним). */
  prev_buckets: AnalyticsBucket[];
  star_usd: number;
  since: { payments: string | null; billing_events: string | null; feature_events: string | null; gate: string | null; llm_calls: string | null; presence: string | null };
  notes: AnalyticsNote[];
}
export type AnalyticsResponse =
  | { meta: AnalyticsMeta; report: "money"; data: MoneyData }
  | { meta: AnalyticsMeta; report: "subs"; data: SubsData }
  | { meta: AnalyticsMeta; report: "ai"; data: AiData }
  | { meta: AnalyticsMeta; report: "act"; data: ActData }
  | { meta: AnalyticsMeta; report: "ret"; data: RetData }
  | { meta: AnalyticsMeta; report: "feat"; data: FeatData }
  | { meta: AnalyticsMeta; report: "parse"; data: ParseData };

export interface MoneyData {
  kpi: {
    revenue_stars: Pair;        // чистая: оплаты в периоде − возвраты в периоде
    revenue_sub_stars: Pair;    // оплаты kind first|renew (по paid_at)
    revenue_once_stars: Pair;   // оплаты kind once
    refunds_stars: Pair;        // сумма amount с refunded_at в периоде (положительное число)
    revenue_micro: Pair;        // round(revenue_stars × star_usd × 1e6)
    ai_micro: Pair;             // расход ИИ (1.6)
    margin_micro: Pair;         // revenue_micro − ai_micro
    active: Pair;               // 1.4
    payers: Pair;               // различные user_id с оплатой в периоде (возвращённые не в счёт)
    arpu_stars: Pair;           // revenue_stars / active; active=0 → null
    arppu_stars: Pair;          // revenue_stars / payers; payers=0 → null
    ltv_stars: Pair;            // всё время до конца окна: Σ(оплаты) − Σ(возвраты) / различные платившие
    avg_check_stars: Pair;      // Σ amount оплат в периоде / число этих оплат; 0 оплат → null
    payments: Pair;             // число оплат в периоде
    ai_per_active_micro: Pair;  // ai_micro / active; active=0 → null
  };
  series: {
    sub_stars: number[]; once_stars: number[];
    refund_stars: number[];                 // положительные; рисуются ВНИЗ от нуля
    revenue_micro: number[]; ai_micro: number[];
    active: number[];
    arpu_stars: (number | null)[];          // чистые звёзды корзины / активные корзины
    ai_per_active_micro: (number | null)[]; // ai корзины / активные корзины
  };
}

export interface SubsData {
  price_stars: number;            // tariffs().price (server/src/tariffs.ts)
  trial_days: number;             // tariffs().trialDays
  kpi: {
    active_subs: Pair; trials: Pair; trials_ending_3d: Pair; autorenew: Pair; churn_risk: Pair;
    trial_conversion: Pair;       // доля 0..1: оплатившие / решённые; решённых 0 → null
    trial_decided: Pair;          // в когорте пробы, у кого конец + 3 дн. <= now
    trial_pending: number;        // в когорте, у кого 3 дня ещё не прошли
    new_subs: Pair; renewals: Pair;
    cancels: Pair;                // billing_events kind canceled в периоде (правило since)
    expired: Pair;                // billing_events kind expired в периоде (правило since)
    refunds: Pair;                // payments с refunded_at в периоде (число)
  };
  series: {
    new: number[]; renewed: number[];        // вверх
    canceled: (number | null)[];             // положительные; рисуются ВНИЗ; null — корзина раньше since billing_events
    expired: (number | null)[];              // так же, вниз
    trial_conversion: (number | null)[];     // по корзине конца пробы
  };
  /** «Кто скоро решит»: до 10 строк, ближайшие сверху. */
  soon: SubsSoonRow[];
}
export interface SubsSoonRow {
  user_id: number;
  what: "trial" | "no_renew";   // проба кончается / подписка без автопродления
  left_days: number;            // ceil((access_until − now) / сутки), не меньше 0
  days_with_us: number;         // floor((now − created_at) / сутки)
  active_days_7: number;        // различные активные дни за 7 последних дней по его поясу
  ai_micro_30: number;          // llm_usage за 30 дней UTC
}

export type AiGroup = "parse" | "talk" | "draw" | "voice" | "background" | "other";
/** Назначения llm_usage.kind → группа (USAGE_KINDS из server/src/llm.ts). Незнакомый kind → other. */
export const AI_GROUPS: { id: AiGroup; kinds: string[] }[] = [
  { id: "parse", kinds: ["parse", "correct"] },
  { id: "talk", kinds: ["chat", "answer"] },
  { id: "draw", kinds: ["draw"] },
  { id: "voice", kinds: ["voice"] },
  { id: "background", kinds: ["summary", "patterns"] },
  { id: "other", kinds: ["other"] },
];
export interface AiData {
  source: "llm_usage" | "llm_calls";
  kpi: {
    total_micro: Pair; calls: Pair;
    unpriced_calls: Pair;              // вызовы без цены (их расход — ноль)
    forecast_month_micro: number | null; // Σ за 7 полных прошедших дней UTC / 7 × 30; не зависит от интервала
    capped_users: Pair;                // различные user_id с gate.day_cap / calls_cap / draws_cap / voice_cap > 0 в днях окна
    capped_share: Pair;                // capped_users / active; active=0 → null
    active: Pair;
    top_user: { user_id: number; micro: number } | null; // самый дорогой за период
    subscribers: number;               // plan='paid' со живым сроком сейчас
    subscriber_avg_micro: number | null;          // средний расход ИИ подписчика за период
    subscriber_avg_revenue_micro: number | null;  // выручка подписки за период на подписчика
  };
  groups: { id: AiGroup; kinds: string[] }[]; // = AI_GROUPS
  series: Record<AiGroup, number[]>;          // micro по корзинам
  /** «Сколько людей тратят сколько» — ВСЕГДА за 30 дней UTC до сегодня, среди активных за эти 30 дней (с нулём — в первую полосу). */
  dist: { id: "lt5c" | "5to20c" | "20to50c" | "50cto1" | "1to3" | "gt3"; from_micro: number; to_micro: number | null; users: number; share: number | null }[];
  dist_users: number;
  /** Модели за период: доля расхода, вызовы, главное назначение, время ответа. Сортировка по micro по убыванию. */
  models: { model: string; micro: number; share: number | null; calls: number; top_kind: string; p50_ms: number | null; p95_ms: number | null; timed: number }[];
  limits: { trial_day_micro: number; paid_day_micro: number; trial_pool_day_micro: number }; // из тарифов (server/src/tariffs.ts) × 1e6
}

export interface ActData {
  kpi: {
    signups: Pair;              // users.created_at в периоде
    requests: Pair;             // обращения к ИИ
    manual: Pair;               // отметки кнопкой, push, правки мышью — «без ИИ»
    active: Pair;
    requests_per_active: Pair;  // requests / active
    manual_per_active: Pair;    // manual / active
    payers_share: Pair;         // (активные с оплатой XTR в периоде) / active
  };
  /** Источники сообщений с ИИ по убыванию объёма (telegram, desktop, app, iphone…), подписи — SOURCE_NAMES. */
  sources: string[];
  series: {
    signups: number[];
    requests: number[];
    requests_by_source: Record<string, number[]>;
    manual: number[];
  };
  /** 24 числа: среднее число сообщений (requests + manual) в местный час суток за день периода. */
  hours: number[];
  /** Неделя × час: минуты присутствия, сложенные по людям, ВСЕГДА за 28 дней до сегодня. Строки пн…вс, столбцы 0…23. */
  heat: number[][];
  heat_days: 28;
}

export interface RetData {
  /** Цифры на «сегодня» t; prev — та же точка неделю назад (t−7), независимо от интервала. */
  kpi: { dau: Pair; wau: Pair; mau: Pair; stickiness: Pair; gone: Pair };
  series: {
    active: number[];       // d — активные за день; h — за час; w — различные активные в 7-дневной корзине
    prev_active: number[];  // то же для prev_buckets (рисуется пунктиром по индексу)
  };
  /** Мост MAU: prev = [t−59, t−30], cur = [t−29, t]. */
  bridge: { prev_mau: number; stayed: number; left: number; new: number; returned: number; mau: number };
  /** Когорты: строка — неделя регистрации, новые снизу. */
  cohorts: { week: string; size: number; cells: ({ share: number; users: number } | null)[] }[];
  cohort_cols: number; // число столбцов Н+0…Н+(cohort_cols−1)
}

export interface FeatData {
  groups: Record<string, string>;   // FEATURE_GROUPS
  since: string | null;             // MIN(day_key) feature_events
  active: Pair;
  kpi: { used: Pair; total: number; per_person: Pair; people: Pair; unused: Pair };
  rows: {
    id: string; title: string; group: string; by: "client" | "server";
    uses: Pair; people: Pair;
    share: Pair;                    // people / active (доля активных)
    clients: Record<string, number>; // uses.cur по клиентам
    spark: number[] | null;         // uses по корзинам; на шаге h — null
  }[];                              // сортировка по uses.cur по убыванию
  unused: string[];                 // id фич с uses.cur = 0 за интервал
}

export type ParseKind = "tasks" | "plans" | "diary" | "habits" | "money" | "other" | "talk";
export const PARSE_KINDS: ParseKind[] = ["tasks", "plans", "diary", "habits", "money", "other", "talk"];
export interface ParseData {
  kpi: {
    requests: Pair; undone: Pair; corrections: Pair; undone_share: Pair; corrections_share: Pair;
    failed_now: number;        // сейчас, без интервала
    failed_retry: number;      // ждут повтора
    clarify_now: number;
    p50_ms: Pair; p95_ms: Pair;
  };
  kinds: ParseKind[];          // = PARSE_KINDS
  series: {
    requests: number[];
    kinds: Record<ParseKind, number[]>;
    err_share: (number | null)[]; // (undone + corrections) / requests корзины; requests=0 → null
  };
}

/** Отчёт в меню раздела; fun и rina — заглушки этапа 2 (запросов не шлют). */
export type AnalyticsTab = AnalyticsReportId | "fun" | "rina";
export const ANALYTICS_REPORTS: { group: string; icon: string; items: { id: AnalyticsTab; title: string; stub?: true }[] }[] = [
  { group: "Деньги", icon: "adm-coins", items: [{ id: "money", title: "Обзор" }, { id: "subs", title: "Подписки" }, { id: "ai", title: "Расход на ИИ" }] },
  { group: "Люди", icon: "adm-users", items: [{ id: "act", title: "Активность" }, { id: "ret", title: "Удержание" }, { id: "fun", title: "Воронки", stub: true }] },
  { group: "Рина и функции", icon: "adm-spark", items: [{ id: "feat", title: "Функции" }, { id: "rina", title: "Рина", stub: true }, { id: "parse", title: "Разбор" }] },
];
/** С этого дня копятся данные для отчётов этапа 2 (Воронки, Рина). */
export const ANALYTICS_COLLECT_SINCE = "2026-11-24";
/** Раз в сколько обновлять открытый отчёт (только при видимой вкладке браузера). */
export const ANALYTICS_REFRESH_MS = 60_000;

/** Отчёт по адресу /admin/analytics/<отчёт>; незнакомый и пустой — «Обзор» (money). */
export function analyticsTab(arg: string | undefined): AnalyticsTab {
  for (const g of ANALYTICS_REPORTS) for (const it of g.items) if (it.id === arg) return it.id;
  return "money";
}

/** Можно ли такой шаг при таком интервале (как сервер: час — до 7 дней, неделя — от 30; у 24 ч — только час, как analyticsFixStep). */
export function analyticsStepOk(days: AnalyticsDays, step: AnalyticsStep): boolean {
  if (days === 1) return step === "h";
  return step === "h" ? days <= 7 : step === "w" ? days >= 30 : true;
}

/** Шаг под интервал, как fixStep макета: 24 ч — час; «час» больше 7 дней и «неделя» меньше 30 — день. */
export function analyticsFixStep(days: AnalyticsDays, step: AnalyticsStep): AnalyticsStep {
  if (days === 1) return "h";
  if (step === "h" && days > 7) return "d";
  if (step === "w" && days < 30) return "d";
  return step;
}

/** Изменение к прошлому периоду: (cur − prev) / prev. Нет числа, prev = 0 или меньше 0,5 % — null («—»). */
export function analyticsDelta(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  const d = (cur - prev) / Math.abs(prev);
  return Math.abs(d) < 0.005 ? null : d;
}

export const AI_GROUP_NAMES: Record<AiGroup, string> = {
  parse: "Разбор сообщений", talk: "Разговор", draw: "Картинки", voice: "Голос", background: "Сводки и связи (фон)", other: "Другое",
};
export const PARSE_KIND_NAMES: Record<ParseKind, string> = {
  tasks: "Задачи", plans: "Планы", diary: "Дневник", habits: "Привычки", money: "Деньги", other: "Другое", talk: "Разговор без записи",
};
export const DIST_NAMES: Record<AiData["dist"][number]["id"], string> = {
  lt5c: "до 5¢", "5to20c": "5–20¢", "20to50c": "20–50¢", "50cto1": "50¢–1$", "1to3": "1–3$", gt3: "больше 3$",
};
/** Группа назначения по llm_usage.kind (незнакомое — «Другое»). */
export const aiGroupOf = (kind: string): AiGroup => AI_GROUPS.find((g) => g.kinds.includes(kind))?.id ?? "other";

/** Сноски под карточками (meta.notes). */
export const ANALYTICS_NOTE_TEXT: Record<AnalyticsNote, string> = {
  hour_from_calls: "на шаге «час» расход — по журналу вызовов, без дневных итогов",
  no_hourly_features: "по часам функций нет — данные по дням",
  days_for_hours: "цифры — за календарные дни, которые задевает окно часов",
  latency_30d_only: "время ответа — только за последние 30 дней",
  prev_before_data: "часть данных начали писать позже — для такого окна «—»",
};

/** Число по-русски ровно с digits знаками: запятая в дробях, тысячи через неразрывный пробел. */
function fixedText(v: number, digits: number): string {
  const [int, frac = ""] = Math.abs(v).toFixed(digits).split(".");
  const g = int.length > 3 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, " ") : int;
  return frac ? `${g},${frac}` : g;
}

/** Число по-русски: запятая в дробях, тысячи через неразрывный пробел; лишние нули справа убираются. */
export function numText(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const [g, frac = ""] = fixedText(v, digits).split(",");
  const f = frac.replace(/0+$/, "");
  const out = f ? `${g},${f}` : g;
  return v < 0 && out !== "0" ? `−${out}` : out;
}

/** Деньги из micro_usd (миллионные доллара): от доллара — «$1,23», меньше — «61¢» (до 10¢ — с десятой: «0,4¢»). */
export function microText(micro: number | null): string {
  if (micro == null || !Number.isFinite(micro)) return "—";
  const a = Math.abs(micro);
  let out: string;
  if (a === 0) out = "$0";
  else if (a < 1_000_000) { const c = a / 10_000; out = `${numText(c, c < 10 ? 1 : 0)}¢`; }
  else out = `$${fixedText(a / 1e6, a < 1e9 ? 2 : 0)}`;
  return micro < 0 ? `−${out}` : out;
}

/** Доля 0..1 → «12,3%» (целые — без запятой); нет числа — «—». */
export function shareText(share: number | null): string {
  if (share == null || !Number.isFinite(share)) return "—";
  return `${numText(share * 100, 1)}%`;
}

/** Стрелка изменения: «+12,3%» / «−4%». */
export function deltaText(d: number): string {
  return `${d > 0 ? "+" : ""}${numText(d * 100, 1)}%`;
}

const RU_MONTHS = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
const pad2 = (n: number) => String(n).padStart(2, "0");
/** День «ГГГГ-ММ-ДД» → «24 нояб.»; с годом — «24 нояб. 2026». */
export function dayText(day: string, year = false): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return day;
  return `${d} ${RU_MONTHS[m - 1]}${year ? ` ${y}` : ""}`;
}

/** Подпись корзины на оси и в подсказке: час — местным временем браузера «24.11 13:00»; день — «24 нояб.»;
 *  неделя — первый день, у неполной — «(N дн.)». */
export function bucketLabel(b: AnalyticsBucket, step: AnalyticsStep): string {
  if (step === "h") {
    const t = new Date(b.key);
    return `${t.getDate()}.${pad2(t.getMonth() + 1)} ${pad2(t.getHours())}:00`;
  }
  const s = dayText(b.key);
  return step === "w" && b.days < 7 ? `${s} (${b.days} дн.)` : s;
}

/** CSV: запятая, точка в дробях, поле с запятой, кавычкой или переводом строки — в кавычках; null — пусто; BOM в начале. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v == null) return "";
    const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/** Имя файла выгрузки: maid-<отчёт>-<таблица>-<дни>d-<ГГГГ-ММ-ДД>.csv. */
export const csvFileName = (report: string, table: string, days: number, today: string) => `maid-${report}-${table}-${days}d-${today}.csv`;

/** Ряды карточки в CSV: корзина (key), её начало и конец, дней в корзине, потом ряды (имена — с единицей). */
export function seriesCsv(buckets: AnalyticsBucket[], cols: { name: string; values: (number | null)[] }[]): string {
  return toCsv(["bucket", "from", "to", "days", ...cols.map((c) => c.name)],
    buckets.map((b, i) => [b.key, b.from, b.to, +b.days.toFixed(4), ...cols.map((c) => c.values[i] ?? null)]));
}
