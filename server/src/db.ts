import { openPostgres, schemaFor, SqliteDriver, type Driver } from "./driver.ts";

// Главное хранилище. Каждая запись знает сообщение, из которого родилась (message_id),
// а каждое действие пишется в actions — по ним работает «Отменить».
// База — SQLite у себя или Postgres на Render: SQL общий, различия прячет driver.ts.

/** Оценка цены вызова без цены от провайдера, доллары (tariffs.ts unpricedOf) — для потолков расхода. */
export type Unpriced = { draw: number; voice: number; other: number };
const NO_EST: Unpriced = { draw: 0, voice: 0, other: 0 };
/** Оценки в целых микродолларах (Postgres ждёт целое: колонка micro_usd — INTEGER). */
const microOf = (e: Unpriced) => [e.draw, e.voice, e.other].map((x) => Math.round(x * 1e6));
/** Добавка к micro_usd строки llm_usage за вызовы без цены (calls - priced); три параметра — оценки draw, voice, остального в микро$. */
const UNPRICED_SQL = "(calls - priced) * (CASE kind WHEN 'draw' THEN CAST(? AS INTEGER) WHEN 'voice' THEN CAST(? AS INTEGER) ELSE CAST(? AS INTEGER) END)";

/** Шаги схемы по порядку; номер последнего пройденного — kv.schema_version. Новое — только дописывать в конец. */
const MIGRATIONS: string[] = [
  `
CREATE TABLE IF NOT EXISTS users (
  id {pk},
  login TEXT UNIQUE,
  password_hash TEXT,
  chat_id TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT 'strict',
  morning_time TEXT NOT NULL DEFAULT '09:00',
  tomorrow_time TEXT NOT NULL DEFAULT '20:00',
  evening_time TEXT NOT NULL DEFAULT '22:00',
  event_lead_min INTEGER NOT NULL DEFAULT 60,
  game_alerts INTEGER NOT NULL DEFAULT 1,
  game_first_min INTEGER NOT NULL DEFAULT 120,
  game_every_min INTEGER NOT NULL DEFAULT 120,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id {pk},
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  text TEXT NOT NULL,
  received_at TEXT NOT NULL,
  day_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'received',
  parse_json TEXT,
  reply TEXT,
  reply_to INTEGER,
  UNIQUE (user_id, source, source_id)
);
CREATE TABLE IF NOT EXISTS diary (
  id {pk},
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  section TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  message_id INTEGER,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS diary_day ON diary (user_id, day_key);
CREATE TABLE IF NOT EXISTS events (
  id {pk},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  date_iso TEXT NOT NULL,
  time TEXT,
  end_time TEXT,
  details TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT 'life',
  status TEXT NOT NULL DEFAULT 'active',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_date ON events (user_id, date_iso);
CREATE TABLE IF NOT EXISTS tasks (
  id {pk},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  category TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS dates (
  id {pk},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  date_iso TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  person TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  yearly INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  message_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (
  id {pk},
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  message_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics (
  id {pk},
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  value {real} NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'text',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS metrics_day ON metrics (user_id, key, day_key);
CREATE TABLE IF NOT EXISTS habits (
  id {pk},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  days TEXT NOT NULL DEFAULT '1234567',
  times TEXT NOT NULL DEFAULT '[]',
  start_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  message_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS habit_marks (
  id {pk},
  habit_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  message_id INTEGER,
  UNIQUE (habit_id, day_key)
);
CREATE TABLE IF NOT EXISTS money (
  id {pk},
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount {real} NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  category TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS money_day ON money (user_id, day_key);
CREATE TABLE IF NOT EXISTS reminders (
  id {pk},
  user_id INTEGER NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TEXT,
  UNIQUE (ref_kind, ref_id, due_at)
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, due_at);
CREATE TABLE IF NOT EXISTS activity (
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  source TEXT NOT NULL,
  active_sec INTEGER NOT NULL DEFAULT 0,
  afk_sec INTEGER NOT NULL DEFAULT 0,
  apps_json TEXT NOT NULL DEFAULT '[]',
  games_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day_key, source)
);
CREATE TABLE IF NOT EXISTS actions (
  id {pk},
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tbl TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  before_json TEXT,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`,
  // Шаг 2: push-подписки браузеров и кнопки у отложенных напоминаний.
  `
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  keys_json TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_ok TEXT
);
ALTER TABLE reminders ADD COLUMN buttons TEXT NOT NULL DEFAULT '';
`,
  // Шаг 3: лента уведомлений — то же, что ушло в Telegram и push, для горничной на ПК.
  `
CREATE TABLE IF NOT EXISTS notices (
  id {pk},
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  emotion TEXT NOT NULL DEFAULT 'neutral',
  buttons TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notices_user ON notices (user_id, id);
`,
  // Шаг 4: иконки программ и игр (трекер ПК присылает значок exe) — для статистики.
  `
CREATE TABLE IF NOT EXISTS app_icons (
  user_id INTEGER NOT NULL,
  name_key TEXT NOT NULL,
  png TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name_key)
);
`,
  // Шаг 5: когда задачу закрыли (любым исходом — для недельной сводки «сбежали от задач»); повтор планов:
  // repeat у первого плана серии (daily, weekdays, weekly, biweekly, monthly), series — id первого у его копий.
  `
ALTER TABLE tasks ADD COLUMN closed_at TEXT;
ALTER TABLE events ADD COLUMN repeat TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN series INTEGER;
`,
  // Шаг 6: спорное — подтвердить кнопками. Пользователь рассказал о своём распорядке или «надо бы когда-нибудь…» —
  // горничная не заводит привычки и задачи сама, а предлагает (proposals). items — JSON пунктов, picked — JSON отмеченных номеров,
  // remind — ситуативная кнопка «Напоминать перед сном» {label, time} или ''. status: open, accepted, declined, expired.
  // tg_chat/tg_msg — сообщение в Telegram, чтобы убрать с него кнопки, когда ответили в другом месте.
  // habits.quiet — привычка «в список», без напоминаний и вечерних вопросов.
  `
CREATE TABLE IF NOT EXISTS proposals (
  id {pk},
  user_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  ask TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL,
  picked TEXT NOT NULL DEFAULT '',
  remind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  tg_chat TEXT,
  tg_msg INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_user ON proposals (user_id, status);
ALTER TABLE habits ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0;
`,
  // Шаг 7: план лёг на занятое время — горничная спрашивает «Сдвинуть?» (clash.ts). «Оставить» запоминает пару (a < b):
  // про неё больше не спрашивает.
  `
CREATE TABLE IF NOT EXISTS clash_kept (
  user_id INTEGER NOT NULL,
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  PRIMARY KEY (user_id, a, b)
);
`,
  // Шаг 8: профиль — дебафы (аллергия, непереносимость, противопоказания) и бафы. Горничная учитывает активные в ответах;
  // закономерности из дневника («плохо после молока» 3 раза) она предлагает (suggested), в дебафы — только после «да».
  `
CREATE TABLE IF NOT EXISTS traits (
  id {pk},
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'debuff',
  category TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  evidence TEXT NOT NULL DEFAULT '',
  message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traits_user ON traits (user_id, status);
`,
  // Шаг 9: когда напоминать о планах — несколько раз (scheduler.ts, remindPlan): «day» — в начале дня, число — за столько минут, 0 — в момент начала.
  // Пусто — как у старых пользователей: за event_lead_min и в момент начала.
  `
ALTER TABLE users ADD COLUMN event_reminders TEXT NOT NULL DEFAULT '';
`,
  // Шаг 10: картинки, нарисованные по просьбе (draw.ts). data — base64: ссылка RunPod живёт 7 дней, картинка хранится у нас.
  `
CREATE TABLE IF NOT EXISTS drawings (
  id {pk},
  user_id INTEGER NOT NULL,
  message_id INTEGER,
  prompt TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drawings_user ON drawings (user_id, id);
`,
  // Шаг 11: расход модели по дням (UTC) × на что ушло × модель: запросы, токены, деньги.
  // micro_usd — миллионные доллара (целым, без ошибок округления); priced — сколько запросов пришло с ценой (у других цены нет).
  `
CREATE TABLE IF NOT EXISTS llm_usage (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  micro_usd INTEGER NOT NULL DEFAULT 0,
  priced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, model)
);
`,
  // Шаг 12: вечерний итог — только до полуночи (иначе в 00:15 приходил итог только что наступившего дня); ночное время → 23:55.
  `
UPDATE users SET evening_time = '23:55' WHERE evening_time < '12:00';
`,
  // Шаг 13: когда спрашивать про привычки без своего времени — первый раз (habit_first) и ещё раз, если не ответили (habit_last); в полночь — минус.
  `
ALTER TABLE users ADD COLUMN habit_first TEXT NOT NULL DEFAULT '12:00';
ALTER TABLE users ADD COLUMN habit_last TEXT NOT NULL DEFAULT '23:00';
`,
  // Шаг 14: расход по людям — user_id в ключе строки (0 — ничей или записан до учёта по людям).
  `
CREATE TABLE llm_usage_by_user (
  day TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  micro_usd INTEGER NOT NULL DEFAULT 0,
  priced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, kind, model)
);
INSERT INTO llm_usage_by_user (day, user_id, kind, model, calls, input, output, micro_usd, priced)
  SELECT day, 0, kind, model, calls, input, output, micro_usd, priced FROM llm_usage;
DROP TABLE llm_usage;
ALTER TABLE llm_usage_by_user RENAME TO llm_usage;
`,
  // Шаг 15: вид письма (утро, план, привычка… — notices.ts) — для «Истории» на сайте; у старых писем пусто.
  `
ALTER TABLE notices ADD COLUMN kind TEXT NOT NULL DEFAULT '';
`,
  // Шаг 16: сколько сделано по привычке за день — только если человек сам написал («прочитал 35 страниц»); иначе NULL.
  `
ALTER TABLE habit_marks ADD COLUMN amount {real};
ALTER TABLE habit_marks ADD COLUMN unit TEXT NOT NULL DEFAULT '';
`,
  // Шаг 17: заметки «на потом» (notes.ts) — что посмотреть, во что поиграть, что почитать, идеи. shelf — полка (film, series,
  // game, book, idea, other); status: open, done (посмотрел / прошёл — с оценкой rating 1–10 или без), deleted (в корзине), purged.
  `
CREATE TABLE IF NOT EXISTS notes (
  id {pk},
  user_id INTEGER NOT NULL,
  shelf TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  rating INTEGER,
  message_id INTEGER,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS notes_user ON notes (user_id, status);
`,
  // Шаг 18: когда важную дату удалили (для корзины, как у задач и заметок); снова активна — пусто.
  `
ALTER TABLE dates ADD COLUMN closed_at TEXT;
`,
  // Шаг 19: «Перекрасить Рину» — цвет волос и глаз горничной (id — look.ts, как в desktop/renderer/look.js); у всех — свои цвета.
  `
ALTER TABLE users ADD COLUMN maid_hair TEXT NOT NULL DEFAULT 'red';
ALTER TABLE users ADD COLUMN maid_eyes TEXT NOT NULL DEFAULT 'violet';
`,
  // Шаг 20: «Персонализация → О вас» (you.ts) — обращение (master/mistress/name), город (JSON: название, регион, координаты, пояс),
  // подъём (час) и отбой (auto или ЧЧ:ММ) — раньше они жили в настройках виджета на каждом ПК; ask — когда и что горничная уже спрашивала.
  `
ALTER TABLE users ADD COLUMN address TEXT NOT NULL DEFAULT 'master';
ALTER TABLE users ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN wake INTEGER NOT NULL DEFAULT 7;
ALTER TABLE users ADD COLUMN bed TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE users ADD COLUMN ask TEXT NOT NULL DEFAULT '';
`,
  // Шаг 21: «Погода утром» (weather.ts) — «Предупредить о дожде за час», если план на улице попадает под дождь; по умолчанию выключено.
  `
ALTER TABLE users ADD COLUMN weather_rain INTEGER NOT NULL DEFAULT 0;
`,
  // Шаг 22: журнал действий в админке сайта (admin.ts): запросил код, вошёл, неверный код, вышел. Без текстов пользователей.
  `
CREATE TABLE IF NOT EXISTS admin_log (
  id {pk},
  at TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS admin_log_at ON admin_log (at);
`,
  // Шаг 23: индексы для отчётов админки (admin-stats.ts): отменённые действия по сообщению и по человеку, сообщения человека по времени.
  `
CREATE INDEX IF NOT EXISTS actions_msg ON actions (message_id, undone);
CREATE INDEX IF NOT EXISTS actions_user ON actions (user_id, undone, created_at);
CREATE INDEX IF NOT EXISTS messages_user_at ON messages (user_id, received_at);
`,
  // Шаг 24: этап 2 админки — клиент и версия у входа (заголовки X-Maid-Client / X-Maid-Version), минуты присутствия по часам
  // (presence, 90 дней), сколько вызовов модели ушло на сообщение и по какой ветке (messages.llm_calls / route),
  // журнал попыток модели (llm_calls, 30 дней): время ответа, цена, короткий код ошибки — без текстов. Индексы messages по времени
  // и состоянию — для отчётов админки по всем людям (дорогие сообщения, ветки, зависшие).
  `
ALTER TABLE sessions ADD COLUMN client TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN version TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_seen ON sessions (last_seen);
CREATE TABLE IF NOT EXISTS presence (
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  hour INTEGER NOT NULL,
  client TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day_key, hour, client)
);
CREATE INDEX IF NOT EXISTS presence_day ON presence (day_key);
ALTER TABLE messages ADD COLUMN llm_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN route TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS llm_calls (
  id {pk},
  at TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  ms INTEGER NOT NULL,
  micro_usd INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS llm_calls_at ON llm_calls (at);
CREATE INDEX IF NOT EXISTS messages_at ON messages (received_at);
CREATE INDEX IF NOT EXISTS messages_state ON messages (state);
`,
  // Шаг 25: у упавших сообщений в reply лежал текст ошибки целиком — с телом ответа провайдера. Теперь там код сбоя
  // (llmErrorCode); старые тексты стираются в 'other', признак упавшего разговора 'chat:' (CHAT_FAILED в pipeline.ts) остаётся.
  `
UPDATE messages SET reply = CASE WHEN reply LIKE 'chat:%' THEN 'chat:other' ELSE 'other' END
  WHERE state = 'failed' AND reply IS NOT NULL AND reply <> '';
`,
  // Шаг 26: этап 3 админки — счётчики фич (feature-events.ts): человек × день (по его поясу) × клиент × фича → сколько раз.
  // Имена — из белого списка feature-list.ts, без текстов. Хранится 400 дней (pruneStats).
  `
CREATE TABLE IF NOT EXISTS feature_events (
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  client TEXT NOT NULL,
  feature TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day_key, client, feature)
);
CREATE INDEX IF NOT EXISTS feature_events_day ON feature_events (day_key);
`,
  // Шаг 27: платный доступ (access.ts, billing.ts). plan: '' — не выдан, friend — бесплатно навсегда, trial — проба или подарок,
  // paid — подписка Telegram Stars, free — срок кончился. access_until — конец пробы или оплаченного месяца (ISO).
  // tg_user_id — кто платит в Telegram, sub_charge_id — charge_id первой оплаты подписки (для отмены продления и возврата).
  // Все, кто уже есть в базе в момент миграции, — друзья: бесплатно навсегда. payments — каждая оплата и возврат, ключ — charge_id
  // (повтор того же обновления Telegram ничего не меняет).
  `
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN access_until TEXT;
ALTER TABLE users ADD COLUMN tg_user_id TEXT;
ALTER TABLE users ADD COLUMN sub_charge_id TEXT;
ALTER TABLE users ADD COLUMN sub_canceled INTEGER NOT NULL DEFAULT 0;
UPDATE users SET plan = 'friend';
CREATE TABLE IF NOT EXISTS payments (
  charge_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  tg_user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  payload TEXT NOT NULL,
  kind TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  expires_at TEXT,
  refunded_at TEXT
);
CREATE INDEX IF NOT EXISTS payments_user ON payments (user_id, paid_at);
CREATE INDEX IF NOT EXISTS payments_at ON payments (paid_at);
`,
  // Шаг 28: журнал подписки (аналитика, этап 0 «начать записывать», docs/review/аналитика-макет-2026-11-24.html): каждое событие
  // доступа — отдельной строкой с временем. kind — BILLING_KINDS: paid_first, paid_once, renewed, canceled, resumed, refunded,
  // expired, trial_ended, gift_ended, trial_started, gift. charge_id и amount (звёзды) — только у оплат и возвратов. Без текстов и
  // Telegram id. Не чистится. Когда шаг пройден, в kv analytics_collect_since — момент начала записи (правило since, admin-analytics.ts).
  `
CREATE TABLE IF NOT EXISTS billing_events (
  id {pk},
  user_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  charge_id TEXT,
  amount INTEGER
);
CREATE INDEX IF NOT EXISTS billing_events_at ON billing_events (at);
CREATE INDEX IF NOT EXISTS billing_events_user ON billing_events (user_id, at);
`,
  // Шаг 29: аналитика, этап 1 (admin-analytics.ts) — отчёты по всем людям идут по дню (messages.day_key, по поясу человека).
  `
CREATE INDEX IF NOT EXISTS messages_day ON messages (day_key);
`,
  // Шаг 30: тарифы из базы (tariffs.ts, этап 1 макета docs/review/тарифы-и-управление-макет-2026-11-24.html). tariff_settings —
  // только изменённые числа (key — поле TARIFF_SPEC, value — JSON); нет строки — берётся значение по умолчанию (прежние числа
  // config.billing, SIGNUPS_OPEN и STAR_USD из .env). tariff_history — каждое «Применить», откат и /signups в боте: кто (user_id
  // админа, 0 — владелец из бота без записи), когда, все числа до и после (JSON), причина. Выключатель /signups off жил в kv
  // signups:closed — переносится в tariff_settings.signupsOpen, ключ kv удаляется (одно место вместо двух).
  `
CREATE TABLE IF NOT EXISTS tariff_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tariff_history (
  id {pk},
  at TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tariff_history_at ON tariff_history (at);
INSERT INTO tariff_settings (key, value, updated_at, updated_by)
  SELECT 'signupsOpen', 'false', '', 0 FROM kv WHERE key = 'signups:closed' AND value = '1';
DELETE FROM kv WHERE key = 'signups:closed';
`,
  // Шаг 31: вид бесплатного срока — явно (access.ts trialLenOf), а не по длине срока и нынешнему тарифу trialDays (его теперь меняют
  // в админке — уже выданные сроки меняли бы смысл). trial_len_days — длина пробы при регистрации в днях, 0 — подарок по /invite
  // (и принятый посреди пробы). NULL — записи до шага 31: вид по длине срока с прежней пробой 7 дней (до тарифов из базы её не
  // меняли). У кого в журнале подписки есть подарок (billing_events gift) — сразу 0.
  `
ALTER TABLE users ADD COLUMN trial_len_days INTEGER;
UPDATE users SET trial_len_days = 0 WHERE id IN (SELECT user_id FROM billing_events WHERE kind = 'gift');
`,
  // Шаг 32: лимиты в штуках (этап 2 тарифов, access.ts AiGate). ai_quota — человек × день (по его поясу) × что (calls — обращения
  // к ИИ, draws — рисунки, voice_sec — секунды голоса) → сколько взято. Прибавка атомарная и не выше лимита (takeQuota); хранится
  // 40 дней (pruneStats). Без текстов.
  `
CREATE TABLE IF NOT EXISTS ai_quota (
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day_key, kind)
);
CREATE INDEX IF NOT EXISTS ai_quota_day ON ai_quota (day_key);
`,
  // Шаг 33: действия с аккаунтом по номеру (этап 3 «Тарифы и управление», admin-account.ts). users.frozen_at — когда аккаунт
  // заморозили (NULL — не заморожен): ИИ, вход и ответы бота закрыты, данные остаются. admin_log.reason — причина действия админа
  // (обязательна у действий с аккаунтом, тарифов и возврата; у входа и кода — пусто).
  `
ALTER TABLE users ADD COLUMN frozen_at TEXT;
ALTER TABLE admin_log ADD COLUMN reason TEXT NOT NULL DEFAULT '';
`,
  // Шаг 34: оповещения владельцу и ночная копия базы (этап 4 «Тарифы и управление», alerts.ts и snapshot.ts). alert_rules — правило
  // по порогу (id — ALERT_SPECS): вкл/выкл, порог, окно и «не чаще раза в» минут; firing — 0 норма, 1 сработало без письма
  // (антиспам), 2 сработало и письмо ушло; mark — до какого момента учтены события (оплаты, возвраты). Строки по умолчанию дописывает
  // alerts.ts при первом чтении (порог расхода зависит от тарифов). alert_log — каждое срабатывание, повтор, «снова норма» и тест:
  // только числа (текст письма собран сервером, без имён и текстов людей). db_copies — ночные копии и проверки восстановления.
  `
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  threshold {real} NOT NULL,
  window_min INTEGER NOT NULL DEFAULT 60,
  every_min INTEGER NOT NULL DEFAULT 60,
  firing INTEGER NOT NULL DEFAULT 0,
  last_sent TEXT,
  last_value {real},
  mark TEXT,
  updated_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alert_log (
  id {pk},
  at TEXT NOT NULL,
  rule TEXT NOT NULL,
  kind TEXT NOT NULL,
  value {real},
  text TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alert_log_at ON alert_log (at);
CREATE TABLE IF NOT EXISTS db_copies (
  id {pk},
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  file TEXT NOT NULL DEFAULT '',
  bytes BIGINT NOT NULL DEFAULT 0,
  gz_bytes BIGINT NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  problem TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  by_user INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS db_copies_at ON db_copies (kind, at);
`,
  // Шаг 35: падения виджета и поэтапный выпуск (этап 5 «Тарифы и управление», crashes.ts и releases.ts). crash_events — день (по
  // поясу человека) × версия × процесс × тип ошибки × место в коде × отпечаток сообщения → сколько раз и у скольких людей (users —
  // число, список людей не хранится). Ни текста ошибки, ни путей ПК. desktop_days — человек × день × версия программы: был ли он с
  // этой версией и сколько раз она у него падала; из неё — доля людей с падением по версии (база — люди этой версии за окно, а не
  // последняя версия входа: сессия помнит только нынешнюю). Обе — 90 дней (pruneStats). Настройка выпуска — kv «desktop:release».
  `
CREATE TABLE IF NOT EXISTS crash_events (
  day_key TEXT NOT NULL,
  version TEXT NOT NULL,
  process TEXT NOT NULL,
  kind TEXT NOT NULL,
  place TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  users INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_key, version, process, kind, place, fingerprint)
);
CREATE TABLE IF NOT EXISTS desktop_days (
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  version TEXT NOT NULL,
  crashes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day_key, version)
);
CREATE INDEX IF NOT EXISTS desktop_days_day ON desktop_days (day_key, version);
`,
  // Шаг 36: этап 6 «Тарифы и управление» — переключатели, промокоды, обращения, объявления. feature_switches — выключенные крупные
  // функции (switches.ts; нет строки — включено). promo_codes — промокоды, которые дарят дни (promo.ts): код, сколько дней, сколько
  // раз всего, до какого момента, вкл/выкл; promo_uses — кто применил (один человек — один код: user_id — ключ). support_tickets —
  // обращения людей (support.ts): тема, текст, статус new | work | closed, ответ. announcements — объявления (announce.ts): текст,
  // кому, где (сайт и/или виджет), вкл/выкл, срок; announcement_seen — кому объявление уже ушло в ленту виджета (один раз).
  `
CREATE TABLE IF NOT EXISTS feature_switches (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS promo_codes (
  id {pk},
  code TEXT NOT NULL UNIQUE,
  days INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  ends_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS promo_uses (
  user_id INTEGER PRIMARY KEY,
  code_id INTEGER NOT NULL,
  days INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS promo_uses_code ON promo_uses (code_id);
CREATE TABLE IF NOT EXISTS support_tickets (
  id {pk},
  user_id INTEGER NOT NULL,
  topic TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS support_tickets_user ON support_tickets (user_id, created_at);
CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets (status, id);
CREATE TABLE IF NOT EXISTS announcements (
  id {pk},
  text TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',
  site INTEGER NOT NULL DEFAULT 1,
  widget INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announcement_seen (
  announcement_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);
`,
  // Шаг 37: «Здоровье сервера» подробно (server-metrics.ts) — снимок нагрузки раз в минуту, хранится 7 дней (SERVER_METRICS_KEEP_DAYS).
  // at — минута (ISO, ключ). Процессор: cpu_proc — % одного ядра у процесса, cpu_ms — мс процессора процесса за минуту, cpu_sys — %
  // машины (все ядра), load1 — средняя нагрузка за минуту (os.loadavg; на Windows 0), cores. Память в МБ: rss, куча, машина (всего,
  // свободно), mem_limit_mb — потолок памяти процесса (ограничение контейнера или вся память машины). Цикл событий: задержка p50 / p99 /
  // max, мс. За минуту: запросы HTTP, время ответа p50 / p95 (мс), ответы 5xx, апдейты бота, вызовы модели и из них с ошибкой, разных
  // активных людей (только число), очередь разбора (сейчас и наибольшая за минуту). Размер базы, свободный и весь диск (МБ, NULL — не
  // измерить), аптайм (с), tick_ms — сколько занял сам снимок. Без имён, номеров и текстов людей.
  `
CREATE TABLE IF NOT EXISTS server_metrics (
  at TEXT PRIMARY KEY,
  cpu_proc {real} NOT NULL DEFAULT 0,
  cpu_ms {real} NOT NULL DEFAULT 0,
  cpu_sys {real},
  load1 {real},
  cores INTEGER NOT NULL DEFAULT 1,
  rss_mb {real} NOT NULL DEFAULT 0,
  heap_mb {real} NOT NULL DEFAULT 0,
  heap_total_mb {real} NOT NULL DEFAULT 0,
  mem_total_mb {real} NOT NULL DEFAULT 0,
  mem_free_mb {real} NOT NULL DEFAULT 0,
  mem_limit_mb {real} NOT NULL DEFAULT 0,
  loop_p50 {real} NOT NULL DEFAULT 0,
  loop_p99 {real} NOT NULL DEFAULT 0,
  loop_max {real} NOT NULL DEFAULT 0,
  http INTEGER NOT NULL DEFAULT 0,
  http_p50 {real},
  http_p95 {real},
  http_5xx INTEGER NOT NULL DEFAULT 0,
  bot INTEGER NOT NULL DEFAULT 0,
  llm INTEGER NOT NULL DEFAULT 0,
  llm_err INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  queue INTEGER NOT NULL DEFAULT 0,
  queue_peak INTEGER NOT NULL DEFAULT 0,
  db_mb {real},
  disk_free_mb {real},
  disk_total_mb {real},
  uptime INTEGER NOT NULL DEFAULT 0,
  tick_ms {real} NOT NULL DEFAULT 0
);
`,
  // Шаг 38: «Счёт OpenRouter» (openrouter-bill.ts) — расход так, как его считает сам OpenRouter (/api/v1/activity, управляющий ключ):
  // день UTC × модель × провайдер. micro_usd — потрачено кредитов OpenRouter (usage), byok_micro — расход по своим ключам провайдеров
  // (byok_usage_inference), в миллионных доллара, как llm_usage. Загрузка за окно заменяет строки этих дней, а не складывает.
  // Без ключей и без людей: только модель, провайдер и числа.
  `
CREATE TABLE IF NOT EXISTS openrouter_bill (
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  micro_usd BIGINT NOT NULL DEFAULT 0,
  byok_micro BIGINT NOT NULL DEFAULT 0,
  requests BIGINT NOT NULL DEFAULT 0,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, provider)
);
`,
];

/** Строка «Счёта OpenRouter» (шаг 38, openrouter-bill.ts): день UTC × модель × провайдер; деньги — миллионные доллара. */
export interface OpenRouterBillRow {
  day: string; model: string; provider: string; micro_usd: number; byok_micro: number; requests: number;
  prompt_tokens: number; completion_tokens: number; reasoning_tokens: number; cached_tokens: number;
}
const OPENROUTER_BILL_COLS = ["day", "model", "provider", "micro_usd", "byok_micro", "requests", "prompt_tokens", "completion_tokens", "reasoning_tokens", "cached_tokens"] as const;

/** Снимок нагрузки сервера за минуту (шаг 37, server-metrics.ts); поля — как столбцы server_metrics. */
export interface ServerMetricRow {
  at: string; cpu_proc: number; cpu_ms: number; cpu_sys: number | null; load1: number | null; cores: number;
  rss_mb: number; heap_mb: number; heap_total_mb: number; mem_total_mb: number; mem_free_mb: number; mem_limit_mb: number;
  loop_p50: number; loop_p99: number; loop_max: number;
  http: number; http_p50: number | null; http_p95: number | null; http_5xx: number;
  bot: number; llm: number; llm_err: number; active: number; queue: number; queue_peak: number;
  db_mb: number | null; disk_free_mb: number | null; disk_total_mb: number | null; uptime: number; tick_ms: number;
}
export const SERVER_METRIC_COLS = [
  "at", "cpu_proc", "cpu_ms", "cpu_sys", "load1", "cores", "rss_mb", "heap_mb", "heap_total_mb", "mem_total_mb", "mem_free_mb", "mem_limit_mb",
  "loop_p50", "loop_p99", "loop_max", "http", "http_p50", "http_p95", "http_5xx", "bot", "llm", "llm_err", "active", "queue", "queue_peak",
  "db_mb", "disk_free_mb", "disk_total_mb", "uptime", "tick_ms",
] as const satisfies readonly (keyof ServerMetricRow)[];
export type ServerMetricCol = (typeof SERVER_METRIC_COLS)[number];
/** Столбцы, где NULL значит «не измерить» (остальные — числа). */
const METRIC_NULLABLE = new Set<string>(["cpu_sys", "load1", "http_p50", "http_p95", "db_mb", "disk_free_mb", "disk_total_mb"]);

/** Виды строк журнала подписки (billing_events, шаг 28). paid_first — первая оплата подписки, paid_once — оплата без признака
 *  подписки, renewed — продление, canceled / resumed — продление отменили / возобновили, refunded — возврат, expired — кончилась
 *  подписка, trial_ended — проба, gift_ended — подарок (планировщик перевёл в free; что кончилось — access.ts endedOf),
 *  trial_started — проба при регистрации, gift — подарок по /invite (новому или продление срока). Из админки (admin-account.ts,
 *  шаг 33): admin_extend — продлили срок, admin_grant — выдали подарок без оплаты (как gift, но не по /invite). Этап 6 (promo.ts):
 *  promo — человек применил промокод (дни добавлены, amount — сколько дней). */
export const BILLING_KINDS = ["paid_first", "paid_once", "renewed", "canceled", "resumed", "refunded", "expired", "trial_ended", "gift_ended", "trial_started", "gift", "admin_extend", "admin_grant", "promo"] as const;
/** kv: когда в этой базе начали писать журнал подписки и отказы ИИ (шаг 28) — начало данных для правила since. */
export const COLLECT_SINCE_KEY = "analytics_collect_since";
/** Номер шага схемы, с которого пишутся billing_events и gate.* (этап 0 аналитики). */
const COLLECT_STEP = 28;
export type BillingKind = (typeof BILLING_KINDS)[number];
export interface BillingEventRow { id: number; user_id: number; at: string; kind: BillingKind; charge_id: string | null; amount: number | null }

/** Строка падений виджета (шаг 35, crashes.ts): users — сколько людей (впервые за день с этим ключом), не их список. */
export interface CrashEventRow { day_key: string; version: string; process: string; kind: string; place: string; fingerprint: string; count: number; users: number }
/** Сколько дней хранятся падения и дни программы по версиям (шаг 35). */
export const CRASH_KEEP_DAYS = 90;

/** Правило оповещения (шаг 34, alerts.ts): firing — 0 норма, 1 сработало без письма (антиспам), 2 сработало и письмо ушло. */
export interface AlertRuleRow {
  id: string; enabled: number; threshold: number; window_min: number; every_min: number;
  firing: number; last_sent: string | null; last_value: number | null; mark: string | null; updated_at: string; updated_by: number;
}
/** Ночная копия (kind copy: status ok | fail | skip) или проверка восстановления (kind verify: ok | warn | fail). problem — что не так
 *  (пусто — всё хорошо), sent — копия ушла владельцу в Telegram. Без имён и текстов людей. */
export interface DbCopyRow {
  id: number; at: string; kind: "copy" | "verify"; status: "ok" | "fail" | "skip" | "warn"; file: string; bytes: number; gz_bytes: number;
  sent: number; problem: string; note: string; by_user: number; ms: number;
}

/** Строка истории тарифов (шаг 30): before_json / after_json — все числа тарифов до и после (JSON), source — admin | undo | bot. */
export interface TariffHistoryRow { id: number; at: string; user_id: number; source: string; before_json: string; after_json: string; reason: string }
const tariffRow = (r: Record<string, unknown>): TariffHistoryRow => ({
  id: Number(r.id), at: String(r.at), user_id: Number(r.user_id), source: String(r.source),
  before_json: String(r.before_json), after_json: String(r.after_json), reason: String(r.reason ?? ""),
});

/** Аккаунт в сводке владельца: last_at — последнее сообщение (ISO), recent — сообщений за период, month/total — расход ИИ в долларах. */
export interface AccountRow {
  id: number; name: string; login: string | null; chat_id: string | null; created_at: string; last_at: string | null; recent: number; month: number; total: number;
}

/** Строка расхода: день (UTC) × на что × модель. cost — доллары. */
export interface UsageRow { day: string; kind: string; model: string; calls: number; input: number; output: number; cost: number; priced: number }

export interface DrawingRow {
  id: number;
  user_id: number;
  message_id: number | null;
  /** Описание для модели картинок (по-английски). */
  prompt: string;
  /** Коротко по-русски, что нарисовано. */
  title: string;
  mime: string;
  /** base64 без префикса data: */
  data: string;
  created_at: string;
}

export interface User {
  id: number;
  login: string | null;
  password_hash: string | null;
  chat_id: string | null;
  name: string;
  tz: string;
  persona: string;
  morning_time: string;
  tomorrow_time: string;
  evening_time: string;
  /** Первый вопрос про привычку без своего времени (12:00). */
  habit_first: string;
  /** Второй вопрос, если до него не ответили (23:00); не ответили и до полуночи — минус. */
  habit_last: string;
  event_lead_min: number;
  event_reminders: string;
  game_alerts: number;
  game_first_min: number;
  game_every_min: number;
  /** «Перекрасить Рину» (look.ts): волосы — id из MAID_HAIR, свои — red. */
  maid_hair: string;
  /** Глаза — id из MAID_EYES, свои — violet. */
  maid_eyes: string;
  /** «О вас» (you.ts): как обращаться — master («хозяин»), mistress («хозяйка»), name (по имени из name). */
  address: string;
  /** Город JSON (you.ts City) или пусто. */
  city: string;
  /** Подъём — минуты от полуночи (04:00–11:59, с 20.11.2026); меньше 24 — час (прежние записи и 7 по умолчанию): читать через wakeMinOf (you.ts). */
  wake: number;
  /** Отбой — auto или ЧЧ:ММ (18:00–03:59). */
  bed: string;
  /** Что горничная уже спрашивала о человеке (you.ts askState): JSON или пусто. */
  ask: string;
  /** «Предупредить о дожде за час» (weather.ts rainSoon): 1 — да. */
  weather_rain: number;
  /** Платный доступ (шаг 27, access.ts): '' | friend | trial | paid | free. */
  plan: string;
  /** Конец пробы или оплаченного месяца (ISO); null — нет срока. */
  access_until: string | null;
  /** Telegram id того, кто платит (обычно = chat_id). */
  tg_user_id: string | null;
  /** charge_id первой оплаты подписки — для editUserStarSubscription и возврата. */
  sub_charge_id: string | null;
  /** 1 — продление подписки отменено (доступ до access_until). */
  sub_canceled: number;
  /** Когда создана запись (ISO): у записей до шага 31 по нему подарок по /invite отличается от пробной недели (access.ts trialLenOf). */
  created_at: string;
  /** Вид бесплатного срока (шаг 31, access.ts trialLenOf): длина пробы при регистрации в днях; 0 — подарок по /invite; null — запись
   *  до шага 31 (вид — по длине срока). */
  trial_len_days: number | null;
  /** Когда аккаунт заморозил админ (шаг 33, admin-account.ts; ISO); null или нет поля — не заморожен (access.ts isFrozen). */
  frozen_at?: string | null;
}

/** Оплата Telegram Stars (billing.ts): kind — first | renew | once; refunded_at — когда вернули. */
export interface PaymentRow {
  charge_id: string;
  user_id: number;
  tg_user_id: string;
  amount: number;
  currency: string;
  payload: string;
  kind: string;
  paid_at: string;
  expires_at: string | null;
  refunded_at: string | null;
}
export interface Message {
  id: number;
  user_id: number;
  source: string;
  source_id: string;
  text: string;
  received_at: string;
  day_key: string;
  state: "received" | "clarify" | "done" | "failed";
  parse_json: string | null;
  reply: string | null;
  reply_to: number | null;
  /** Сколько раз модель звали ради этого сообщения (повторы прибавляются) и по какой ветке оно прошло (pipeline.ts, шаг 24). */
  llm_calls?: number;
  route?: string;
}
export interface DiaryRow {
  id: number;
  day_key: string;
  section: string;
  topic: string;
  text: string;
  message_id: number | null;
  created_at: string;
}
export interface EventRow {
  id: number;
  user_id: number;
  title: string;
  date_iso: string;
  time: string | null;
  end_time: string | null;
  details: string;
  domain: string;
  status: string;
  message_id: number | null;
  /** Повтор серии (только у первого плана серии), '' — не повторяется. */
  repeat?: string;
  /** id первого плана серии — у копий, созданных повтором. */
  series?: number | null;
}
export interface TaskRow {
  id: number;
  user_id: number;
  title: string;
  priority: string;
  category: string;
  due_date: string | null;
  notes: string;
  status: string;
  message_id: number | null;
  created_at: string;
  done_at: string | null;
  /** Когда закрыли (сделано, отменено, не буду, сбежал); null — открыта. */
  closed_at?: string | null;
}
export interface DateRow {
  id: number;
  user_id: number;
  title: string;
  date_iso: string;
  type: string;
  person: string;
  notes: string;
  yearly: number;
  status: string;
  /** Когда записали: год даты не раньше года записи — год неизвестен (report.ts yearKnown). */
  created_at?: string;
  closed_at?: string | null;
}
/** Заметка «на потом» (notes.ts): полка shelf, пометка note, оценка rating — когда отмечена готовой. */
export interface NoteRow {
  id: number;
  user_id: number;
  shelf: string;
  title: string;
  note: string;
  status: string;
  rating: number | null;
  message_id: number | null;
  created_at: string;
  /** Когда отметили готовой или удалили; null — лежит на полке. */
  closed_at: string | null;
}
export interface MemoryRow {
  id: number;
  kind: string;
  subject: string;
  text: string;
  status: string;
  created_at: string;
}
export interface MetricRow {
  id: number;
  user_id: number;
  day_key: string;
  key: string;
  label: string;
  value: number;
  unit: string;
  note: string;
  source: string;
  message_id: number | null;
}
export interface HabitRow {
  id: number;
  user_id: number;
  title: string;
  /** Дни недели цифрами, 1 — понедельник … 7 — воскресенье. */
  days: string;
  /** JSON-массив времён «ЧЧ:ММ» для напоминаний. */
  times: string;
  start_date: string;
  end_date: string | null;
  status: string;
  message_id: number | null;
  /** 1 — «в список»: без напоминаний и вечерних вопросов. */
  quiet?: number;
}
export interface ProposalRow {
  id: number;
  user_id: number;
  message_id: number;
  text: string;
  ask: string;
  items: string;
  picked: string;
  remind: string;
  status: "open" | "accepted" | "declined" | "expired";
  tg_chat: string | null;
  tg_msg: number | null;
  created_at: string;
}
/** Дебаф или баф профиля. status: active — действует; suggested — горничная заметила, ждёт «да»; declined — «не надо»
 *  (больше не предлагать); removed — сняли. source: user — сам на экране профиля, chat — сказал горничной, pattern — найдено в дневнике. */
export interface TraitRow {
  id: number;
  user_id: number;
  kind: "debuff" | "buff";
  category: string;
  title: string;
  note: string;
  source: string;
  status: "active" | "suggested" | "declined" | "removed";
  /** JSON: дни, по которым замечена закономерность (ГГГГ-ММ-ДД). */
  evidence: string;
  message_id: number | null;
  created_at: string;
  updated_at: string;
}
export interface MarkRow {
  id: number;
  habit_id: number;
  day_key: string;
  status: "done" | "skipped";
  at: string;
  message_id: number | null;
  /** Сколько сделано за день (35 страниц) — только из слов человека; null — просто отметка. */
  amount: number | null;
  /** «стр.», «км», «мин»; пусто, если числа нет. */
  unit: string;
}
export interface MoneyRow {
  id: number;
  user_id: number;
  day_key: string;
  kind: "income" | "expense";
  amount: number;
  currency: string;
  category: string;
  note: string;
  message_id: number | null;
}
export interface ReminderRow {
  id: number;
  user_id: number;
  ref_kind: string;
  ref_id: number;
  due_at: string;
  text: string;
  status: string;
  /** JSON-массив кнопок (scheduler.Button) или пусто. */
  buttons: string;
}
export interface NoticeRow {
  id: number;
  user_id: number;
  text: string;
  emotion: string;
  buttons: string;
  at: string;
  /** Вид письма (NOTICE_KINDS в notices.ts); пусто — записано до появления видов. */
  kind: string;
}
export interface PushSub {
  endpoint: string;
  user_id: number;
  keys_json: string;
  label: string;
  created_at: string;
  last_ok: string | null;
}
export interface ActivityRow {
  user_id: number;
  day_key: string;
  source: string;
  active_sec: number;
  afk_sec: number;
  apps: { name: string; sec: number }[];
  games: { name: string; sec: number }[];
  updated_at: string;
}
export interface ActionRow {
  id: number;
  message_id: number;
  kind: string;
  tbl: string;
  row_id: number;
  before_json: string | null;
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
/** Админка: обращения к горничной, которые разбирает модель (без поправок к ответам), и действия без модели. */
// Отметки привычек кнопкой в Telegram (bot.ts, source_id «mark:…»), на сайте (web) и в виджете Telegram — без модели.
const ADMIN_AI_SQL = "(m.source IN ('telegram', 'desktop', 'app', 'iphone') AND m.source_id NOT LIKE 'correct:%' AND m.source_id NOT LIKE 'mark:%')";
const ADMIN_MANUAL_SQL = "(m.source IN ('button', 'push', 'panel', 'web', 'telegram-widget') OR m.source_id LIKE 'mark:%')";
/** Окно выборки сообщений для аналитики: дни по поясу человека (messages.day_key, включительно) или моменты [fromIso, toIso). */
export type AnalyticsRange = { fromDay: string; toDay: string } | { fromIso: string; toIso: string };
const rangeSql = (r: AnalyticsRange): [string, string, string] =>
  "fromDay" in r ? ["m.day_key >= ? AND m.day_key <= ?", r.fromDay, r.toDay] : ["m.received_at >= ? AND m.received_at < ?", r.fromIso, r.toIso];

export type Table = "diary" | "events" | "tasks" | "dates" | "memory" | "metrics" | "habits" | "habit_marks" | "money" | "traits" | "notes";
/** Таблицы, строку которых берёт lockRow (у всех есть user_id; у отметок привычек его нет). */
const LOCKABLE = ["messages", "diary", "events", "tasks", "dates", "memory", "metrics", "habits", "money", "traits", "notes"];

// ——— Удаление аккаунта (admin-account.ts, действие delete). Каждая таблица со столбцом user_id — в одном из трёх списков ниже;
// server/test/account-delete.test.ts читает схему (все таблицы с user_id) и падает, если новая таблица ни в одном списке.
/** Строки человека, которые удаляются целиком (habit_marks — через habits, у неё user_id нет). */
export const ACCOUNT_TABLES = [
  "sessions", "messages", "diary", "events", "tasks", "dates", "memory", "metrics", "habits", "money", "reminders", "activity", "actions",
  "push_subs", "notices", "app_icons", "proposals", "clash_kept", "traits", "drawings", "notes", "presence", "feature_events", "ai_quota",
  "desktop_days", "promo_uses", "support_tickets", "announcement_seen",
] as const;
/** Деньги остаются, но отвязываются от человека — суммы и счёт людей в отчётах не меняются: оплаты и журнал подписки — на номер −id
 *  (отрицательных у живых нет; разные удалённые — разные плательщики), Telegram id плательщика в payments стирается; расход модели
 *  (llm_usage, llm_calls) — на 0, «без человека», как записи до учёта по людям (строки llm_usage одного дня складываются). */
export const ACCOUNT_DETACH_TABLES = ["payments", "billing_events", "llm_usage", "llm_calls"] as const;
/** user_id здесь — админ, сделавший действие (не тот, о ком оно); админа удалить нельзя — строки не трогаются. Строки журнала админа
 *  про удалённого («#N …» в detail) тоже остаются: там только номер. */
export const ACCOUNT_ACTOR_TABLES = ["admin_log", "tariff_history"] as const;
/** Ключи kv с номером человека: ровно «<префикс>:<id>» и «<префикс>:<id>:…». series:<id>:<день> — раскладка серий человека, а
 *  series:<план>:laid — по номеру плана (ниже, по строкам events): у первых хвост — день, «laid» не трогается. */
export const USER_KV_EXACT = ["album", "paylink", "widget", "cheer", "profile", "persona-first"] as const;
export const USER_KV_PREFIX = [
  "game", "subend", "backup", "rain", "morning", "tomorrow", "evening", "escapes", "habitMinus", "patterns", "series", "youoffer", "wx:snow",
] as const;
/** Наибольший номер удалённого аккаунта (SQLite: новый номер — больше него, Store.newUserId). */
export const USERS_GONE_KEY = "users:gone_max";

export class Store {
  private constructor(readonly driver: Driver) {}

  /** Адрес postgres://… — Postgres, иначе путь к файлу SQLite (или ":memory:"). */
  static async open(target: string): Promise<Store> {
    const d = /^postgres(ql)?:\/\//.test(target) ? await openPostgres(target) : new SqliteDriver(target);
    return Store.over(d);
  }
  static async over(driver: Driver): Promise<Store> {
    const s = new Store(driver);
    await s.migrate();
    return s;
  }
  close() {
    return this.driver.close();
  }

  private async migrate() {
    await this.driver.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    let v = Number((await this.kvGet("schema_version")) ?? 0);
    while (v < MIGRATIONS.length) {
      const step = MIGRATIONS[v];
      await this.driver.tx(async () => {
        await this.driver.exec(schemaFor(this.driver.dialect, step));
        await this.kvSet("schema_version", String(v + 1));
        if (v + 1 === COLLECT_STEP) await this.kvSet(COLLECT_SINCE_KEY, now());
      });
      v++;
    }
  }

  private all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    return this.driver.all<T>(sql, args);
  }
  private async get<T>(sql: string, ...args: unknown[]): Promise<T | undefined> {
    return (await this.driver.all<T>(sql, args))[0];
  }
  private run(sql: string, ...args: unknown[]): Promise<number> {
    return this.driver.run(sql, args);
  }
  /** INSERT … и номер новой строки. */
  private async insert(sql: string, ...args: unknown[]): Promise<number> {
    const r = await this.driver.all<{ id: number }>(`${sql} RETURNING id`, args);
    return Number(r[0].id);
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.driver.tx(fn);
  }
  /** Правка строки по полям — только из списка allowed (журнал отмены возвращает «как было» этим же путём). */
  private async patchRow(table: string, id: number, patch: Record<string, unknown>, allowed: string[]) {
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) throw new Error(`bad field ${k}`);
      await this.run(`UPDATE ${table} SET ${k} = ? WHERE id = ?`, v as never, id);
    }
  }

  // --- пользователи ---
  /** Номер новой записи в SQLite — явно, больше всех живых и удалённых (kv USERS_GONE_KEY): SQLite без AUTOINCREMENT отдаёт
   *  MAX(id) + 1, и удалённый последним номер достался бы новому человеку — вместе со строками журнала админа «#N» и отвязанными
   *  оплатами. Одной командой INSERT (не SELECT, потом INSERT) — два одновременных входа не возьмут один номер. В Postgres номер
   *  выдаёт IDENTITY, он не повторяется — колонку не трогаем. */
  private newUserId(): [string, string] {
    if (this.driver.dialect !== "sqlite") return ["", ""];
    return ["id, ", `(SELECT MAX(n) + 1 FROM (SELECT COALESCE(MAX(id), 0) AS n FROM users UNION ALL SELECT CAST(value AS INTEGER) FROM kv WHERE key = '${USERS_GONE_KEY}')), `];
  }
  userByChat(chatId: string): Promise<User | undefined> {
    return this.get<User>("SELECT * FROM users WHERE chat_id = ?", chatId);
  }
  userByLogin(login: string): Promise<User | undefined> {
    return this.get<User>("SELECT * FROM users WHERE login = ?", login.toLowerCase());
  }
  user(id: number): Promise<User | undefined> {
    return this.get<User>("SELECT * FROM users WHERE id = ?", id);
  }
  users(): Promise<User[]> {
    return this.all<User>("SELECT * FROM users ORDER BY id");
  }
  /** Пользователь по чату Telegram (создаётся при первом сообщении). */
  async ensureUser(chatId: string, name: string, tz: string): Promise<User> {
    const u = await this.userByChat(chatId);
    if (u) return u;
    const [idCol, idVal] = this.newUserId();
    await this.run(
      `INSERT INTO users (${idCol}chat_id, name, tz, created_at) VALUES (${idVal}?, ?, ?, ?) ON CONFLICT (chat_id) DO NOTHING`,
      chatId, name, tz, now(),
    );
    return (await this.userByChat(chatId))!;
  }
  /** plan и access_until — платный доступ (access.ts): новые из бота — проба, по /invite — подарок, из командной строки — друг. */
  async createUser(u: {
    login: string; passwordHash: string; name?: string; tz: string; chatId?: string | null; plan?: string; accessUntil?: string | null; at?: Date;
    /** Вид бесплатного срока (users.trial_len_days): длина пробы в днях, 0 — подарок. */
    trialLenDays?: number | null;
  }): Promise<User> {
    const [idCol, idVal] = this.newUserId();
    const id = await this.insert(
      `INSERT INTO users (${idCol}login, password_hash, chat_id, name, tz, created_at, plan, access_until, trial_len_days) VALUES (${idVal}?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u.login.toLowerCase(), u.passwordHash, u.chatId ?? null, u.name ?? "", u.tz, (u.at ?? new Date()).toISOString(), u.plan ?? "", u.accessUntil ?? null,
      u.trialLenDays ?? null,
    );
    return (await this.user(id))!;
  }
  /** Сколько учётных записей создано с since (ISO) — потолок регистраций в час (invite.ts signUp, тариф signupsPerHour). */
  async countUsersSince(since: string): Promise<number> {
    return Number((await this.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", since))?.n ?? 0);
  }
  /** Новые с since (ISO): для сводки владельцу раз в сутки — только счёт, логин и план (без chat id и текстов). */
  async usersCreatedSince(since: string): Promise<{ id: number; login: string | null; plan: string }[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT id, login, plan FROM users WHERE created_at >= ? ORDER BY id", since);
    return rows.map((r) => ({ id: Number(r.id), login: r.login == null ? null : String(r.login), plan: String(r.plan ?? "") }));
  }
  /** Кто платит этим Telegram (tg_user_id или chat_id). */
  userByTg(tgId: string): Promise<User | undefined> {
    return this.get<User>("SELECT * FROM users WHERE tg_user_id = ? OR chat_id = ? ORDER BY CASE WHEN tg_user_id = ? THEN 0 ELSE 1 END, id LIMIT 1", tgId, tgId, tgId);
  }
  /** Проба или подписка кончилась раньше before (ISO), а план ещё trial/paid — их переводит в free планировщик (billing.ts expire). */
  usersToExpire(before: string): Promise<User[]> {
    return this.all<User>("SELECT * FROM users WHERE plan IN ('trial', 'paid') AND access_until IS NOT NULL AND access_until < ? ORDER BY id", before);
  }
  /** Подписки с отменённым продлением, кончаются с from по to (ISO) — напомнить за 3 дня. */
  canceledEndingBetween(from: string, to: string): Promise<User[]> {
    return this.all<User>("SELECT * FROM users WHERE plan = 'paid' AND sub_canceled = 1 AND access_until >= ? AND access_until <= ? ORDER BY id", from, to);
  }
  /** Расход ИИ человека за день (UTC, ГГГГ-ММ-ДД), доллары — денежный потолок (access.ts). Вызов без цены (провайдер её не вернул)
   *  идёт по оценке est (access.ts передаёт tariffs.ts unpricedOf): иначе потолок его не видит. */
  async daySpend(userId: number, day: string, est: Unpriced = NO_EST): Promise<number> {
    const r = await this.get<{ micro: number }>(`SELECT SUM(micro_usd + ${UNPRICED_SQL}) AS micro FROM llm_usage WHERE day = ? AND user_id = ?`,
      ...microOf(est), day, userId);
    return Number(r?.micro ?? 0) / 1e6;
  }
  /** Расход всех проб за день (UTC) с той же оценкой — общий потолок проб (access.ts, тариф trialPoolDayUsd). */
  async trialsDaySpend(day: string, est: Unpriced = NO_EST): Promise<number> {
    const r = await this.get<{ micro: number }>(
      `SELECT SUM(micro_usd + ${UNPRICED_SQL}) AS micro FROM llm_usage WHERE day = ? AND user_id IN (SELECT id FROM users WHERE plan = 'trial')`,
      ...microOf(est), day,
    );
    return Number(r?.micro ?? 0) / 1e6;
  }

  // --- лимиты в штуках (шаг 32, access.ts) ---
  /** Взять n штук kind за день day, если вместе с уже взятым выходит не больше limit: одна команда «вставить или прибавить, если
   *  влезает» — одновременные запросы лимит не превышают. true — взято. */
  async takeQuota(userId: number, day: string, kind: string, n: number, limit: number): Promise<boolean> {
    if (n <= 0) return true;
    if (n > limit) return false;
    const r = await this.all<{ n: number }>(
      `INSERT INTO ai_quota (user_id, day_key, kind, n) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, day_key, kind) DO UPDATE SET n = ai_quota.n + excluded.n WHERE ai_quota.n + excluded.n <= ? RETURNING n`,
      userId, day, kind, n, limit,
    );
    return r.length > 0;
  }
  /** Прибавить n штук kind за день без предела (прибавка админа, admin-account.ts bonus). Не takeQuota с огромным пределом:
   *  в Postgres параметр предела — INTEGER (int4), число больше 2 147 483 647 роняет запрос. */
  async addQuota(userId: number, day: string, kind: string, n: number): Promise<void> {
    if (n <= 0) return;
    await this.run(
      `INSERT INTO ai_quota (user_id, day_key, kind, n) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, day_key, kind) DO UPDATE SET n = ai_quota.n + excluded.n`,
      userId, day, kind, n,
    );
  }
  /** Вернуть n штук (не ниже нуля). */
  async giveQuota(userId: number, day: string, kind: string, n: number): Promise<void> {
    if (n <= 0) return;
    await this.run("UPDATE ai_quota SET n = CASE WHEN n > ? THEN n - ? ELSE 0 END WHERE user_id = ? AND day_key = ? AND kind = ?", n, n, userId, day, kind);
  }
  /** Сколько взято за день: calls, draws, voice_sec (нет строки — 0). */
  async quotaOf(userId: number, day: string): Promise<{ calls: number; draws: number; voice_sec: number }> {
    const out = { calls: 0, draws: 0, voice_sec: 0 };
    for (const r of await this.all<Record<string, unknown>>("SELECT kind, n FROM ai_quota WHERE user_id = ? AND day_key = ?", userId, day)) {
      const k = String(r.kind);
      if (k === "calls" || k === "draws" || k === "voice_sec") out[k] = Number(r.n) || 0;
    }
    return out;
  }
  /** Прибавка админа к лимитам на день (шаг 33, access.ts BONUS_PREFIX): строки bonus_calls, bonus_draws, bonus_voice_sec. */
  async quotaBonus(userId: number, day: string): Promise<{ calls: number; draws: number; voice_sec: number }> {
    const out = { calls: 0, draws: 0, voice_sec: 0 };
    for (const r of await this.all<Record<string, unknown>>("SELECT kind, n FROM ai_quota WHERE user_id = ? AND day_key = ? AND kind IN ('bonus_calls', 'bonus_draws', 'bonus_voice_sec')", userId, day)) {
      const k = String(r.kind).slice("bonus_".length);
      if (k === "calls" || k === "draws" || k === "voice_sec") out[k] = Number(r.n) || 0;
    }
    return out;
  }
  /** Все счётчики с day_key >= since (экономика тарифа в админке, tariffs.ts): человек × день × что → сколько. */
  async quotaRows(since: string): Promise<{ user_id: number; day: string; kind: string; n: number }[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT user_id, day_key, kind, n FROM ai_quota WHERE day_key >= ?", since);
    return rows.map((r) => ({ user_id: Number(r.user_id), day: String(r.day_key), kind: String(r.kind), n: Number(r.n) || 0 }));
  }

  // --- оплаты (billing.ts) ---
  /** Записать оплату; false — такой charge_id уже есть (повтор обновления Telegram). */
  async addPayment(p: Omit<PaymentRow, "refunded_at">): Promise<boolean> {
    return (await this.run(
      `INSERT INTO payments (charge_id, user_id, tg_user_id, amount, currency, payload, kind, paid_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (charge_id) DO NOTHING`,
      p.charge_id, p.user_id, p.tg_user_id, p.amount, p.currency, p.payload.slice(0, 128), p.kind, p.paid_at, p.expires_at,
    )) > 0;
  }
  async payment(chargeId: string): Promise<PaymentRow | undefined> {
    const r = await this.get<PaymentRow>("SELECT * FROM payments WHERE charge_id = ?", chargeId);
    return r && { ...r, user_id: Number(r.user_id), amount: Number(r.amount) };
  }
  /** Оплаты человека, новые сверху. */
  async paymentsOf(userId: number): Promise<PaymentRow[]> {
    const rows = await this.all<PaymentRow>("SELECT * FROM payments WHERE user_id = ? ORDER BY paid_at DESC, charge_id", userId);
    return rows.map((r) => ({ ...r, user_id: Number(r.user_id), amount: Number(r.amount) }));
  }
  /** Пометить возврат; false — уже был. */
  async setPaymentRefunded(chargeId: string, at: string): Promise<boolean> {
    return (await this.run("UPDATE payments SET refunded_at = ? WHERE charge_id = ? AND refunded_at IS NULL", at, chargeId)) > 0;
  }
  /** Строка журнала подписки (шаг 28). Незнакомый вид — ошибка (опечатка в коде, а не данные). */
  async addBillingEvent(e: { user_id: number; kind: BillingKind; at?: Date; charge_id?: string | null; amount?: number | null }) {
    if (!BILLING_KINDS.includes(e.kind)) throw new Error(`bad billing kind ${e.kind}`);
    await this.run(
      "INSERT INTO billing_events (user_id, at, kind, charge_id, amount) VALUES (?, ?, ?, ?, ?)",
      e.user_id, (e.at ?? new Date()).toISOString(), e.kind, e.charge_id ?? null, e.amount ?? null,
    );
  }
  /** Журнал подписки за [from, to) (ISO), по времени. */
  async billingEvents(from: string, to: string): Promise<BillingEventRow[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT id, user_id, at, kind, charge_id, amount FROM billing_events WHERE at >= ? AND at < ? ORDER BY at, id", from, to,
    );
    return rows.map((r) => ({
      id: Number(r.id), user_id: Number(r.user_id), at: String(r.at), kind: String(r.kind) as BillingKind,
      charge_id: r.charge_id == null ? null : String(r.charge_id), amount: r.amount == null ? null : Number(r.amount),
    }));
  }
  /** Последние оплаты всех (админка): без payload и charge_id целиком — только хвост для сверки. */
  async adminPayments(limit = 200): Promise<PaymentRow[]> {
    const rows = await this.all<PaymentRow>("SELECT * FROM payments ORDER BY paid_at DESC LIMIT ?", limit);
    return rows.map((r) => ({ ...r, user_id: Number(r.user_id), amount: Number(r.amount) }));
  }
  /** Звёзды с since (ISO) без возвращённых. */
  async starsSince(since: string): Promise<number> {
    const r = await this.get<{ n: number }>("SELECT SUM(amount) AS n FROM payments WHERE paid_at >= ? AND refunded_at IS NULL AND currency = 'XTR'", since);
    return Number(r?.n ?? 0);
  }
  /** Сколько людей на каком плане (админка): активные подписки и пробы, у кого срок кончился. */
  async planCounts(now: string): Promise<{ paid: number; trial: number; expired: number; friend: number }> {
    const r = await this.get<Record<string, unknown>>(
      `SELECT SUM(CASE WHEN plan = 'paid' AND access_until >= ? THEN 1 ELSE 0 END) AS paid,
              SUM(CASE WHEN plan = 'trial' AND access_until >= ? THEN 1 ELSE 0 END) AS trial,
              SUM(CASE WHEN plan = 'free' OR (plan IN ('trial', 'paid') AND (access_until IS NULL OR access_until < ?)) THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN plan = 'friend' THEN 1 ELSE 0 END) AS friend
       FROM users`, now, now, now,
    );
    const n = (v: unknown) => Number(v ?? 0) || 0;
    return { paid: n(r?.paid), trial: n(r?.trial), expired: n(r?.expired), friend: n(r?.friend) };
  }
  async updateUser(id: number, patch: Partial<Omit<User, "id">>) {
    for (const [k, v] of Object.entries(patch)) {
      if (!/^[a-z_]+$/.test(k)) throw new Error(`bad field ${k}`);
      await this.run(`UPDATE users SET ${k} = ? WHERE id = ?`, v as never, id);
    }
  }

  // --- входы (сессии веб-приложения и ключи устройств) ---
  async addSession(tokenHash: string, userId: number, label: string, meta?: { client: string; version: string }) {
    const t = now();
    await this.run(
      "INSERT INTO sessions (token_hash, user_id, label, created_at, last_seen, client, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      tokenHash, userId, label, t, t, meta?.client ?? "", meta?.version ?? "",
    );
  }
  sessionUser(tokenHash: string): Promise<(User & { last_seen: string; session_label: string; session_client: string }) | undefined> {
    return this.get(
      "SELECT u.*, s.last_seen, s.label AS session_label, s.client AS session_client FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", tokenHash,
    );
  }
  /** last_seen — сейчас; клиент и версию — только если пришли (пустые не затирают известные). */
  async touchSession(tokenHash: string, client = "", version = "") {
    await this.run(
      "UPDATE sessions SET last_seen = ?, client = COALESCE(NULLIF(?, ''), client), version = COALESCE(NULLIF(?, ''), version) WHERE token_hash = ?",
      now(), client, version, tokenHash,
    );
  }
  /** Ещё одна минута, в которую человек заходил с этого клиента (час — по его поясу). Не время в сети, а минуты с запросами. */
  async bumpPresence(userId: number, dayKey: string, hour: number, client: string) {
    await this.run(
      `INSERT INTO presence (user_id, day_key, hour, client, minutes) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (user_id, day_key, hour, client) DO UPDATE SET minutes = presence.minutes + 1`,
      userId, dayKey, hour, client.slice(0, 20),
    );
  }
  async dropSession(tokenHash: string) {
    await this.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }
  /** id — начало хеша ключа (сам ключ по нему не узнать): по нему устройство можно выключить из настроек. */
  sessionsOf(userId: number): Promise<{ id: string; label: string; created_at: string; last_seen: string }[]> {
    return this.all("SELECT substr(token_hash, 1, 16) AS id, label, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC", userId);
  }
  /** Выйти на устройстве по id из sessionsOf. Сколько входов закрыто. */
  async dropSessionOf(userId: number, id: string): Promise<number> {
    const rows = await this.all<{ token_hash: string }>("SELECT token_hash FROM sessions WHERE user_id = ?", userId);
    const hit = rows.filter((r) => r.token_hash.slice(0, 16) === id);
    for (const r of hit) await this.dropSession(r.token_hash);
    return hit.length;
  }

  // --- сообщения ---
  /** Сохранить входящее. Повтор того же source_id возвращает уже сохранённое (created = false). */
  async saveMessage(m: { userId: number; source: string; sourceId: string; text: string; dayKey: string; replyTo?: number; at?: Date }) {
    const find = () => this.get<Message>(
      "SELECT * FROM messages WHERE user_id = ? AND source = ? AND source_id = ?", m.userId, m.source, m.sourceId,
    );
    const old = await find();
    if (old) return { message: old, created: false };
    const added = await this.run(
      `INSERT INTO messages (user_id, source, source_id, text, received_at, day_key, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, source, source_id) DO NOTHING`,
      m.userId, m.source, m.sourceId, m.text, (m.at ?? new Date()).toISOString(), m.dayKey, m.replyTo ?? null,
    );
    return { message: (await find())!, created: added > 0 };
  }
  message(id: number): Promise<Message | undefined> {
    return this.get<Message>("SELECT * FROM messages WHERE id = ?", id);
  }
  /** Сообщение по id источника (повтор доставки — до списания лимита, pipeline.ts delivered). */
  messageBySource(userId: number, source: string, sourceId: string): Promise<Message | undefined> {
    return this.get<Message>("SELECT * FROM messages WHERE user_id = ? AND source = ? AND source_id = ?", userId, source, sourceId);
  }
  /** Прибавить вызовы модели к сообщению и запомнить ветку (пустая ветка прежнюю не затирает). */
  async addMessageCalls(id: number, calls: number, route: string) {
    await this.run(
      "UPDATE messages SET llm_calls = llm_calls + ?, route = COALESCE(NULLIF(?, ''), route) WHERE id = ?",
      Math.max(0, Math.round(calls)), route.slice(0, 20), id,
    );
  }
  async setMessage(id: number, patch: { state?: Message["state"]; parse_json?: string; reply?: string }) {
    if (patch.state) await this.run("UPDATE messages SET state = ? WHERE id = ?", patch.state, id);
    if (patch.parse_json !== undefined) await this.run("UPDATE messages SET parse_json = ? WHERE id = ?", patch.parse_json, id);
    if (patch.reply !== undefined) await this.run("UPDATE messages SET reply = ? WHERE id = ?", patch.reply, id);
  }
  /** Сообщения, разбор которых упал, не раньше since — для фонового повтора. */
  failedMessages(since: Date): Promise<Message[]> {
    return this.all<Message>("SELECT * FROM messages WHERE state = 'failed' AND received_at >= ? ORDER BY id", since.toISOString());
  }
  /** Сообщение, которое ждёт уточнения (последнее). */
  pendingClarify(userId: number): Promise<Message | undefined> {
    return this.get<Message>("SELECT * FROM messages WHERE user_id = ? AND state = 'clarify' ORDER BY id DESC LIMIT 1", userId);
  }
  lastDoneMessage(userId: number): Promise<Message | undefined> {
    return this.get<Message>(
      `SELECT m.* FROM messages m WHERE m.user_id = ? AND m.state = 'done'
       AND EXISTS (SELECT 1 FROM actions a WHERE a.message_id = m.id AND a.undone = 0)
       ORDER BY m.id DESC LIMIT 1`, userId,
    );
  }
  async recentMessages(userId: number, limit: number): Promise<Message[]> {
    return (await this.all<Message>(
      "SELECT * FROM messages WHERE user_id = ? AND source <> 'import' ORDER BY id DESC LIMIT ?", userId, limit,
    )).reverse();
  }
  /** Сообщения в ответ на messageId (reply_to), от старых к новым: ответ на уточнение, поправки к ответу. */
  repliesTo(userId: number, messageId: number): Promise<Message[]> {
    return this.all<Message>("SELECT * FROM messages WHERE user_id = ? AND reply_to = ? ORDER BY id", userId, messageId);
  }
  /** Забрать сообщение: state → done, если ещё не done. false — его уже закончил другой запрос (повтор доставки пришёл,
   *  пока первый ждал модель); в Postgres второй ждёт строку до конца первой транзакции и видит done. */
  async claimMessage(id: number): Promise<boolean> {
    return (await this.run("UPDATE messages SET state = 'done' WHERE id = ? AND state <> 'done'", id)) > 0;
  }
  /** Ответ сообщению, пока его не закончили (state не done), — одним запросом, без чтения перед ним: сбой одного из двух
   *  запросов с тем же id не перезапишет итог другого (поправка к ответу). false — уже done, ответ не тронут. */
  async replyUnlessDone(id: number, reply: string): Promise<boolean> {
    return (await this.run("UPDATE messages SET reply = ? WHERE id = ? AND state <> 'done'", reply, id)) > 0;
  }
  /** Взять строку до конца транзакции — первой инструкцией, пока в транзакции ничего не прочитано. В Postgres (READ COMMITTED,
   *  пул соединений) правка поля самим собой держит блокировку строки до COMMIT: вторая транзакция с тем же lockRow ждёт первую
   *  и потом видит её итог; в SQLite транзакции и так идут по одной. Поправка к ответу и «↩ Отменить» берут строку ответа
   *  (messages), поправка — ещё и правимую запись. Поле — не из уникального ключа (у messages user_id в нём): так это
   *  обычная блокировка правки. false — строки нет. */
  async lockRow(table: Exclude<Table, "habit_marks"> | "messages", id: number): Promise<boolean> {
    if (!LOCKABLE.includes(table)) throw new Error(`bad table ${table}`);
    const field = table === "messages" ? "state" : "user_id";
    return (await this.run(`UPDATE ${table} SET ${field} = ${field} WHERE id = ?`, id)) > 0;
  }

  // --- действия (для отмены) ---
  async logAction(userId: number, messageId: number, kind: string, tbl: Table, rowId: number, before?: unknown) {
    await this.run(
      "INSERT INTO actions (user_id, message_id, kind, tbl, row_id, before_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      userId, messageId, kind, tbl, rowId, before === undefined ? null : JSON.stringify(before), now(),
    );
  }
  actionsOf(messageId: number): Promise<ActionRow[]> {
    return this.all<ActionRow>("SELECT * FROM actions WHERE message_id = ? AND undone = 0 ORDER BY id DESC", messageId);
  }
  /** Сообщение уже отменяли: в журнале есть его отменённые действия. */
  async wasUndone(messageId: number): Promise<boolean> {
    return Boolean(await this.get("SELECT 1 AS x FROM actions WHERE message_id = ? AND undone = 1 LIMIT 1", messageId));
  }
  async markUndone(actionId: number) {
    await this.run("UPDATE actions SET undone = 1 WHERE id = ?", actionId);
  }

  // --- дневник ---
  addDiary(userId: number, dayKey: string, section: string, text: string, messageId: number | null, topic = ""): Promise<number> {
    return this.insert(
      "INSERT INTO diary (user_id, day_key, section, topic, text, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      userId, dayKey, section, topic, text, messageId, now(),
    );
  }
  diaryOf(userId: number, dayKey: string): Promise<DiaryRow[]> {
    return this.all<DiaryRow>("SELECT * FROM diary WHERE user_id = ? AND day_key = ? AND deleted = 0 ORDER BY id", userId, dayKey);
  }
  diaryRange(userId: number, from: string, to: string): Promise<DiaryRow[]> {
    return this.all<DiaryRow>(
      "SELECT * FROM diary WHERE user_id = ? AND day_key BETWEEN ? AND ? AND deleted = 0 ORDER BY day_key, id", userId, from, to,
    );
  }
  /** Все записи раздела (для поиска; фильтр по словам — в коде: SQLite не знает регистра кириллицы). */
  diarySection(userId: number, section: string): Promise<DiaryRow[]> {
    return this.all<DiaryRow>(
      "SELECT * FROM diary WHERE user_id = ? AND section = ? AND deleted = 0 ORDER BY day_key, id", userId, section,
    );
  }
  async diaryTopics(userId: number, section: string): Promise<{ topic: string; n: number; last: string }[]> {
    return this.all(
      `SELECT topic, CAST(COUNT(*) AS INTEGER) AS n, MAX(day_key) AS last FROM diary
       WHERE user_id = ? AND section = ? AND deleted = 0 GROUP BY topic ORDER BY n DESC`, userId, section,
    );
  }
  async diaryDays(userId: number): Promise<string[]> {
    return (await this.all<{ day_key: string }>(
      "SELECT DISTINCT day_key FROM diary WHERE user_id = ? AND deleted = 0 ORDER BY day_key", userId,
    )).map((r) => r.day_key);
  }
  /** Дни, где есть записи, и сколько их — для навигации по дневнику. */
  diaryDayCounts(userId: number): Promise<{ day: string; n: number }[]> {
    return this.all<{ day: string; n: number }>(
      "SELECT day_key AS day, COUNT(*) AS n FROM diary WHERE user_id = ? AND deleted = 0 GROUP BY day_key ORDER BY day_key", userId,
    ).then((rows) => rows.map((r) => ({ day: r.day, n: Number(r.n) })));
  }
  diaryRow(id: number): Promise<(DiaryRow & { user_id: number; deleted: number }) | undefined> {
    return this.get<DiaryRow & { user_id: number; deleted: number }>("SELECT * FROM diary WHERE id = ?", id);
  }
  async setDiaryDeleted(id: number, deleted: boolean) {
    await this.run("UPDATE diary SET deleted = ? WHERE id = ?", deleted ? 1 : 0, id);
  }
  /** Поправка к ответу (correct.ts): текст, раздел, подраздел здоровья, день. «Отменить» возвращает прежнее тем же методом. */
  async updateDiary(id: number, patch: Partial<Pick<DiaryRow, "text" | "section" | "topic" | "day_key">>) {
    await this.patchRow("diary", id, patch, ["text", "section", "topic", "day_key"]);
  }

  // --- планы ---
  addEvent(e: Omit<EventRow, "id" | "status"> & { status?: string }): Promise<number> {
    const t = now();
    return this.insert(
      `INSERT INTO events (user_id, title, date_iso, time, end_time, details, domain, status, message_id, created_at, updated_at, repeat, series)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.user_id, e.title, e.date_iso, e.time, e.end_time, e.details, e.domain, e.status ?? "active", e.message_id, t, t, e.repeat ?? "", e.series ?? null,
    );
  }
  event(id: number): Promise<EventRow | undefined> {
    return this.get<EventRow>("SELECT * FROM events WHERE id = ?", id);
  }
  async updateEvent(id: number, patch: Partial<Pick<EventRow, "title" | "date_iso" | "time" | "end_time" | "details" | "status" | "repeat" | "series">>) {
    for (const [k, v] of Object.entries(patch)) {
      await this.run(`UPDATE events SET ${k} = ?, updated_at = ? WHERE id = ?`, v as never, now(), id);
    }
  }
  eventsBetween(userId: number, from: string, to: string, status = "active"): Promise<EventRow[]> {
    return this.all<EventRow>(
      `SELECT * FROM events WHERE user_id = ? AND date_iso BETWEEN ? AND ? AND status = ?
       ORDER BY date_iso, COALESCE(time, '99:99'), id`,
      userId, from, to, status,
    );
  }
  /** Планы после дня after, добавленные или изменённые не раньше since (ISO) — виджет ПК замечает далёкие планы из Telegram. */
  eventsChangedSince(userId: number, after: string, since: string): Promise<EventRow[]> {
    return this.all<EventRow>(
      `SELECT * FROM events WHERE user_id = ? AND date_iso > ? AND status = 'active' AND updated_at >= ?
       ORDER BY updated_at DESC, id DESC LIMIT 20`,
      userId, after, since,
    );
  }
  /** Отменённые и удалённые (в том числе отменой записи) с from и дальше, изменённые не раньше since. */
  eventsClosedSince(userId: number, from: string, since: string, statuses = ["cancelled", "deleted"]): Promise<EventRow[]> {
    return this.all<EventRow>(
      `SELECT * FROM events WHERE user_id = ? AND date_iso >= ? AND status IN (${statuses.map(() => "?").join(", ")}) AND updated_at >= ?
       ORDER BY updated_at DESC, id DESC LIMIT 20`,
      userId, from, ...statuses, since,
    );
  }
  /** Корзина: отменённые и удалённые планы, изменённые не раньше since (ISO), свежие первыми. */
  trashEvents(userId: number, since: string): Promise<EventRow[]> {
    return this.all<EventRow>(
      `SELECT * FROM events WHERE user_id = ? AND status IN ('cancelled', 'deleted') AND updated_at >= ?
       ORDER BY updated_at DESC, id DESC LIMIT 200`,
      userId, since,
    );
  }
  allEvents(userId: number): Promise<EventRow[]> {
    return this.all<EventRow>("SELECT * FROM events WHERE user_id = ? ORDER BY date_iso, COALESCE(time, '99:99'), id", userId);
  }

  // --- задачи ---
  addTask(t: Omit<TaskRow, "id" | "status" | "created_at" | "done_at"> & { status?: string; created_at?: string; done_at?: string | null }): Promise<number> {
    return this.insert(
      "INSERT INTO tasks (user_id, title, priority, category, due_date, notes, status, message_id, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      t.user_id, t.title, t.priority, t.category, t.due_date, t.notes, t.status ?? "open", t.message_id, t.created_at ?? now(), t.done_at ?? null,
    );
  }
  task(id: number): Promise<TaskRow | undefined> {
    return this.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  }
  // at — время отметки (по умолчанию сейчас; виджет Telegram передаёт своё «сейчас», с которым считает «сегодня»).
  async updateTask(id: number, patch: Partial<Pick<TaskRow, "title" | "due_date" | "status" | "priority" | "notes">>, at?: Date) {
    for (const [k, v] of Object.entries(patch)) await this.run(`UPDATE tasks SET ${k} = ? WHERE id = ?`, v as never, id);
    if (patch.status) {
      const when = at ? at.toISOString() : now();
      await this.run("UPDATE tasks SET done_at = ? WHERE id = ?", patch.status === "done" ? when : null, id);
      await this.run("UPDATE tasks SET closed_at = ? WHERE id = ?", patch.status === "open" ? null : when, id);
    }
  }
  /** Задачи, закрытые как сделанные в промежутке [from, to) — «сделано сегодня» у виджета. */
  doneTasksBetween(userId: number, from: Date, to: Date): Promise<TaskRow[]> {
    return this.all<TaskRow>(
      "SELECT * FROM tasks WHERE user_id = ? AND status = 'done' AND done_at >= ? AND done_at < ? ORDER BY done_at",
      userId, from.toISOString(), to.toISOString(),
    );
  }
  openTasks(userId: number): Promise<TaskRow[]> {
    return this.all<TaskRow>(
      `SELECT * FROM tasks WHERE user_id = ? AND status = 'open'
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, COALESCE(due_date, '9999'), id`,
      userId,
    );
  }
  /** Корзина: удалённые и отменённые задачи, закрытые не раньше since (ISO), свежие первыми. */
  trashTasks(userId: number, since: string): Promise<TaskRow[]> {
    return this.all<TaskRow>(
      `SELECT * FROM tasks WHERE user_id = ? AND status IN ('deleted', 'cancelled') AND closed_at >= ?
       ORDER BY closed_at DESC, id DESC LIMIT 200`,
      userId, since,
    );
  }
  /** «Удалить навсегда» в корзине: задачи и планы из корзины (удалённые/отменённые не раньше since) получают статус purged —
   *  в корзине их больше нет. Строки остаются: на них ссылается журнал отмены. pick не задан — вся корзина. */
  async purgeTrash(userId: number, since: string, pick?: { tasks?: number[]; events?: number[]; notes?: number[]; dates?: number[] }): Promise<{ tasks: number; events: number; notes: number; dates: number }> {
    const ids = (list: number[] = []) => (!pick ? "" : list.length ? ` AND id IN (${list.map(() => "?").join(", ")})` : " AND 0");
    const tasks = await this.run(
      `UPDATE tasks SET status = 'purged' WHERE user_id = ? AND status IN ('deleted', 'cancelled') AND closed_at >= ?${ids(pick?.tasks)}`,
      userId, since, ...(pick?.tasks ?? []),
    );
    const events = await this.run(
      `UPDATE events SET status = 'purged' WHERE user_id = ? AND status IN ('cancelled', 'deleted') AND updated_at >= ?${ids(pick?.events)}`,
      userId, since, ...(pick?.events ?? []),
    );
    const notes = await this.run(
      `UPDATE notes SET status = 'purged' WHERE user_id = ? AND status = 'deleted' AND closed_at >= ?${ids(pick?.notes)}`,
      userId, since, ...(pick?.notes ?? []),
    );
    const dates = await this.run(
      `UPDATE dates SET status = 'purged' WHERE user_id = ? AND status = 'deleted' AND closed_at >= ?${ids(pick?.dates)}`,
      userId, since, ...(pick?.dates ?? []),
    );
    return { tasks, events, notes, dates };
  }
  allTasks(userId: number): Promise<TaskRow[]> {
    return this.all<TaskRow>("SELECT * FROM tasks WHERE user_id = ? ORDER BY id", userId);
  }

  // --- заметки «на потом» ---
  addNote(n: { user_id: number; shelf: string; title: string; note: string; message_id: number | null }): Promise<number> {
    return this.insert(
      "INSERT INTO notes (user_id, shelf, title, note, status, message_id, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?)",
      n.user_id, n.shelf, n.title, n.note, n.message_id, now(),
    );
  }
  note(id: number): Promise<NoteRow | undefined> {
    return this.get<NoteRow>("SELECT * FROM notes WHERE id = ?", id);
  }
  /** Правка заметки; смена статуса ставит closed_at (open — снова пусто). at — время отметки (тесты). */
  async updateNote(id: number, patch: Partial<Pick<NoteRow, "shelf" | "title" | "note" | "status" | "rating">>, at?: Date) {
    for (const [k, v] of Object.entries(patch)) await this.run(`UPDATE notes SET ${k} = ? WHERE id = ?`, v as never, id);
    if (patch.status) await this.run("UPDATE notes SET closed_at = ? WHERE id = ?", patch.status === "open" ? null : at ? at.toISOString() : now(), id);
  }
  /** Заметки на полках: открытые и готовые, свежие первыми. */
  notesOf(userId: number): Promise<NoteRow[]> {
    return this.all<NoteRow>("SELECT * FROM notes WHERE user_id = ? AND status IN ('open', 'done') ORDER BY id DESC", userId);
  }
  /** Корзина: удалённые заметки не раньше since (ISO), свежие первыми. */
  trashNotes(userId: number, since: string): Promise<NoteRow[]> {
    return this.all<NoteRow>(
      "SELECT * FROM notes WHERE user_id = ? AND status = 'deleted' AND closed_at >= ? ORDER BY closed_at DESC, id DESC LIMIT 200",
      userId, since,
    );
  }
  allNotes(userId: number): Promise<NoteRow[]> {
    return this.all<NoteRow>("SELECT * FROM notes WHERE user_id = ? ORDER BY id", userId);
  }

  // --- важные даты ---
  addDate(d: Omit<DateRow, "id" | "status"> & { message_id: number | null; status?: string }): Promise<number> {
    return this.insert(
      "INSERT INTO dates (user_id, title, date_iso, type, person, notes, yearly, status, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      d.user_id, d.title, d.date_iso, d.type, d.person, d.notes, d.yearly, d.status ?? "active", d.message_id, now(),
    );
  }
  date(id: number): Promise<DateRow | undefined> {
    return this.get<DateRow>("SELECT * FROM dates WHERE id = ?", id);
  }
  async setDateStatus(id: number, status: string) {
    await this.updateDate(id, { status });
  }
  /** Правка даты; смена статуса ставит closed_at (active — снова пусто), чтобы удалённая попала в корзину. */
  async updateDate(id: number, patch: Partial<Pick<DateRow, "title" | "date_iso" | "type" | "yearly" | "status">>) {
    for (const [k, v] of Object.entries(patch)) await this.run(`UPDATE dates SET ${k} = ? WHERE id = ?`, v as never, id);
    if (patch.status) await this.run("UPDATE dates SET closed_at = ? WHERE id = ?", patch.status === "active" ? null : now(), id);
  }
  /** Корзина: удалённые даты не раньше since (ISO), свежие первыми. */
  trashDates(userId: number, since: string): Promise<DateRow[]> {
    return this.all<DateRow>(
      "SELECT * FROM dates WHERE user_id = ? AND status = 'deleted' AND closed_at >= ? ORDER BY closed_at DESC, id DESC LIMIT 200",
      userId, since,
    );
  }
  activeDates(userId: number): Promise<DateRow[]> {
    return this.all<DateRow>("SELECT * FROM dates WHERE user_id = ? AND status = 'active' ORDER BY substr(date_iso, 6), id", userId);
  }

  // --- память ---
  addMemory(userId: number, kind: string, subject: string, text: string, messageId: number | null): Promise<number> {
    return this.insert(
      "INSERT INTO memory (user_id, kind, subject, text, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      userId, kind, subject, text, messageId, now(),
    );
  }
  async setMemoryStatus(id: number, status: string) {
    await this.run("UPDATE memory SET status = ? WHERE id = ?", status, id);
  }
  activeMemory(userId: number): Promise<(MemoryRow & { user_id: number })[]> {
    return this.all("SELECT * FROM memory WHERE user_id = ? AND status = 'active' ORDER BY id", userId);
  }
  /** Одна запись памяти (и заменённая — status superseded): карточка «Запомнила» после поправки к ответу (correct.ts). */
  memoryRow(id: number): Promise<(MemoryRow & { user_id: number }) | undefined> {
    return this.get<MemoryRow & { user_id: number }>("SELECT * FROM memory WHERE id = ?", id);
  }

  // --- профиль: дебафы и бафы ---
  addTrait(t: Pick<TraitRow, "user_id" | "kind" | "category" | "title" | "note" | "source" | "status" | "evidence" | "message_id">): Promise<number> {
    const at = now();
    return this.insert(
      "INSERT INTO traits (user_id, kind, category, title, note, source, status, evidence, message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      t.user_id, t.kind, t.category, t.title, t.note, t.source, t.status, t.evidence, t.message_id, at, at,
    );
  }
  trait(id: number): Promise<TraitRow | undefined> {
    return this.get<TraitRow>("SELECT * FROM traits WHERE id = ?", id);
  }
  /** Все, кроме снятых (removed) — снятые не нужны ни экрану, ни горничной. declined — чтобы не предлагать снова. */
  traitsOf(userId: number): Promise<TraitRow[]> {
    return this.all<TraitRow>("SELECT * FROM traits WHERE user_id = ? AND status <> 'removed' ORDER BY id", userId);
  }
  async updateTrait(id: number, f: Partial<Pick<TraitRow, "status" | "title" | "note" | "category" | "kind">>) {
    const keys = Object.keys(f) as (keyof typeof f)[];
    if (!keys.length) return;
    await this.run(`UPDATE traits SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => f[k]), now(), id);
  }

  /** Для уровня профиля: сделано задач, отмечено привычек, дней с записями в дневнике. */
  async xpCounts(userId: number): Promise<{ tasks: number; habits: number; days: number }> {
    const n = async (sql: string) => Number((await this.get<{ n: number | string }>(sql, userId))?.n ?? 0);
    return {
      tasks: await n("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'done'"),
      habits: await n("SELECT COUNT(*) AS n FROM habit_marks m JOIN habits h ON h.id = m.habit_id WHERE h.user_id = ? AND m.status = 'done'"),
      days: await n("SELECT COUNT(DISTINCT day_key) AS n FROM diary WHERE user_id = ? AND deleted = 0"),
    };
  }

  // --- показатели дня: вес, сон в часах, шаги, оценки… (новый ключ — новая «колонка» без правки схемы) ---
  addMetric(m: Omit<MetricRow, "id">): Promise<number> {
    return this.insert(
      "INSERT INTO metrics (user_id, day_key, key, label, value, unit, note, source, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.user_id, m.day_key, m.key, m.label, m.value, m.unit, m.note, m.source, m.message_id, now(),
    );
  }
  /** Одно значение на день от источника (шаги с айфона): заменить прежнее. */
  async setDayMetric(m: Omit<MetricRow, "id" | "message_id" | "note"> & { note?: string }): Promise<number> {
    const old = await this.get<{ id: number }>(
      "SELECT id FROM metrics WHERE user_id = ? AND day_key = ? AND key = ? AND source = ? AND deleted = 0",
      m.user_id, m.day_key, m.key, m.source,
    );
    if (old) {
      await this.run("UPDATE metrics SET value = ?, created_at = ? WHERE id = ?", m.value, now(), old.id);
      return old.id;
    }
    return this.addMetric({ ...m, note: m.note ?? "", message_id: null });
  }
  metric(id: number): Promise<(MetricRow & { deleted: number }) | undefined> {
    return this.get<MetricRow & { deleted: number }>("SELECT * FROM metrics WHERE id = ?", id);
  }
  metricsRange(userId: number, from: string, to: string, key?: string): Promise<MetricRow[]> {
    return key
      ? this.all<MetricRow>(
        "SELECT * FROM metrics WHERE user_id = ? AND key = ? AND day_key BETWEEN ? AND ? AND deleted = 0 ORDER BY day_key, id",
        userId, key, from, to,
      )
      : this.all<MetricRow>(
        "SELECT * FROM metrics WHERE user_id = ? AND day_key BETWEEN ? AND ? AND deleted = 0 ORDER BY day_key, id", userId, from, to,
      );
  }
  metricKeys(userId: number): Promise<{ key: string; label: string; unit: string; n: number }[]> {
    return this.all(
      `SELECT key, MAX(label) AS label, MAX(unit) AS unit, CAST(COUNT(*) AS INTEGER) AS n FROM metrics
       WHERE user_id = ? AND deleted = 0 GROUP BY key ORDER BY n DESC`, userId,
    );
  }
  async setMetricDeleted(id: number, deleted: boolean) {
    await this.run("UPDATE metrics SET deleted = ? WHERE id = ?", deleted ? 1 : 0, id);
  }
  /** Поправка к ответу: число, день, пометка (ключ, подпись и единица — от вида показателя, не правятся). */
  async updateMetric(id: number, patch: Partial<Pick<MetricRow, "value" | "day_key" | "note">>) {
    await this.patchRow("metrics", id, patch, ["value", "day_key", "note"]);
  }

  // --- привычки ---
  addHabit(h: Omit<HabitRow, "id" | "status"> & { status?: string }): Promise<number> {
    return this.insert(
      "INSERT INTO habits (user_id, title, days, times, start_date, end_date, status, message_id, quiet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      h.user_id, h.title, h.days, h.times, h.start_date, h.end_date, h.status ?? "active", h.message_id, h.quiet ?? 0, now(),
    );
  }
  habit(id: number): Promise<HabitRow | undefined> {
    return this.get<HabitRow>("SELECT * FROM habits WHERE id = ?", id);
  }
  async updateHabit(id: number, patch: Partial<Pick<HabitRow, "title" | "days" | "times" | "end_date" | "status" | "quiet">>) {
    for (const [k, v] of Object.entries(patch)) await this.run(`UPDATE habits SET ${k} = ? WHERE id = ?`, v as never, id);
  }
  /** Привычки, которые идут в этот день (по датам; день недели проверяет habits.ts). */
  habitsOn(userId: number, day: string): Promise<HabitRow[]> {
    return this.all<HabitRow>(
      `SELECT * FROM habits WHERE user_id = ? AND status = 'active' AND start_date <= ?
       AND (end_date IS NULL OR end_date >= ?) ORDER BY id`, userId, day, day,
    );
  }
  activeHabits(userId: number): Promise<HabitRow[]> {
    return this.all<HabitRow>("SELECT * FROM habits WHERE user_id = ? AND status = 'active' ORDER BY id", userId);
  }
  /** Отметить день; вернуть номер отметки и что было до неё (для отмены). add — сколько сделано (из слов человека):
   *  прибавляется к числу дня в той же единице; без add число дня остаётся как было. */
  async markHabit(habitId: number, day: string, status: MarkRow["status"], messageId: number | null, add?: { amount: number; unit: string }) {
    const before = await this.get<MarkRow>("SELECT * FROM habit_marks WHERE habit_id = ? AND day_key = ?", habitId, day);
    const same = before?.amount != null && before.unit === add?.unit;
    const amount = add ? (same ? Number(before!.amount) : 0) + add.amount : before?.amount ?? null;
    const unit = add ? add.unit : before?.unit ?? "";
    const id = await this.insert(
      `INSERT INTO habit_marks (habit_id, day_key, status, at, message_id, amount, unit) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (habit_id, day_key) DO UPDATE SET status = excluded.status, at = excluded.at, message_id = excluded.message_id,
         amount = excluded.amount, unit = excluded.unit`,
      habitId, day, status, now(), messageId, amount, unit,
    );
    return { id, before };
  }
  async restoreMark(id: number, before: MarkRow | null) {
    if (!before) await this.run("DELETE FROM habit_marks WHERE id = ?", id);
    // Строки может уже не быть (отметку сняли) — тогда вставляется заново с прежними значениями.
    else await this.run(
      `INSERT INTO habit_marks (habit_id, day_key, status, at, message_id, amount, unit) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (habit_id, day_key) DO UPDATE SET status = excluded.status, at = excluded.at, message_id = excluded.message_id,
         amount = excluded.amount, unit = excluded.unit`,
      before.habit_id, before.day_key, before.status, before.at, before.message_id, before.amount ?? null, before.unit ?? "",
    );
  }
  /** Снять отметку дня (галочку поставили по ошибке). */
  async deleteMark(id: number) {
    await this.run("DELETE FROM habit_marks WHERE id = ?", id);
  }
  marksOf(userId: number, from: string, to: string): Promise<MarkRow[]> {
    return this.all<MarkRow>(
      `SELECT m.* FROM habit_marks m JOIN habits h ON h.id = m.habit_id
       WHERE h.user_id = ? AND m.day_key BETWEEN ? AND ? ORDER BY m.day_key`, userId, from, to,
    );
  }

  // --- деньги ---
  addMoney(m: Omit<MoneyRow, "id">): Promise<number> {
    return this.insert(
      "INSERT INTO money (user_id, day_key, kind, amount, currency, category, note, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.user_id, m.day_key, m.kind, m.amount, m.currency, m.category, m.note, m.message_id, now(),
    );
  }
  moneyRange(userId: number, from: string, to: string): Promise<MoneyRow[]> {
    return this.all<MoneyRow>(
      "SELECT * FROM money WHERE user_id = ? AND day_key BETWEEN ? AND ? AND deleted = 0 ORDER BY day_key, id", userId, from, to,
    );
  }
  async setMoneyDeleted(id: number, deleted: boolean) {
    await this.run("UPDATE money SET deleted = ? WHERE id = ?", deleted ? 1 : 0, id);
  }
  /** Одна запись денег (и удалённая — deleted = 1). */
  money(id: number): Promise<(MoneyRow & { deleted: number }) | undefined> {
    return this.get<MoneyRow & { deleted: number }>("SELECT * FROM money WHERE id = ?", id);
  }
  /** Поправка к ответу: сумма, валюта, трата/доход, категория, на что, день. */
  async updateMoney(id: number, patch: Partial<Pick<MoneyRow, "amount" | "currency" | "kind" | "category" | "note" | "day_key">>) {
    await this.patchRow("money", id, patch, ["amount", "currency", "kind", "category", "note", "day_key"]);
  }

  // --- напоминания ---
  /** Отменённое на тот же момент оживает (перепланировали после смены настройки или плана), отправленное остаётся. */
  async addReminder(userId: number, refKind: string, refId: number, dueAt: Date, text: string, buttons = "") {
    await this.run(
      "INSERT INTO reminders (user_id, ref_kind, ref_id, due_at, text, buttons) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (ref_kind, ref_id, due_at) " +
        "DO UPDATE SET status = 'pending', text = excluded.text, buttons = excluded.buttons WHERE reminders.status = 'cancelled'",
      userId, refKind, refId, dueAt.toISOString(), text, buttons,
    );
  }

  // --- нарисованные картинки ---
  addDrawing(d: Pick<DrawingRow, "user_id" | "message_id" | "prompt" | "title" | "mime" | "data">): Promise<number> {
    return this.insert(
      "INSERT INTO drawings (user_id, message_id, prompt, title, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      d.user_id, d.message_id, d.prompt, d.title, d.mime, d.data, now(),
    );
  }
  drawing(id: number): Promise<DrawingRow | undefined> {
    return this.get<DrawingRow>("SELECT * FROM drawings WHERE id = ?", id);
  }

  // --- предложения (подтвердить кнопками) ---
  addProposal(p: Pick<ProposalRow, "user_id" | "message_id" | "text" | "ask" | "items" | "picked" | "remind">): Promise<number> {
    return this.insert(
      "INSERT INTO proposals (user_id, message_id, text, ask, items, picked, remind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      p.user_id, p.message_id, p.text, p.ask, p.items, p.picked, p.remind, now(),
    );
  }
  proposal(id: number): Promise<ProposalRow | undefined> {
    return this.get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id);
  }
  /** Открытые: у одного пользователя или (без userId) у всех, созданные раньше before. */
  openProposals(userId: number | null, before?: string): Promise<ProposalRow[]> {
    return userId === null
      ? this.all<ProposalRow>("SELECT * FROM proposals WHERE status = 'open' AND created_at < ? ORDER BY id", before ?? now())
      : this.all<ProposalRow>("SELECT * FROM proposals WHERE user_id = ? AND status = 'open' ORDER BY id", userId);
  }
  async updateProposal(id: number, patch: Partial<Pick<ProposalRow, "picked" | "status" | "tg_chat" | "tg_msg">>) {
    for (const [k, v] of Object.entries(patch)) await this.run(`UPDATE proposals SET ${k} = ? WHERE id = ?`, v as never, id);
  }

  // --- наложения планов, которые решили оставить (a < b) ---
  async keepClash(userId: number, a: number, b: number) {
    await this.run("INSERT INTO clash_kept (user_id, a, b) VALUES (?, ?, ?) ON CONFLICT (user_id, a, b) DO NOTHING", userId, a, b);
  }
  async clashKept(userId: number, a: number, b: number): Promise<boolean> {
    return !!(await this.get("SELECT 1 AS x FROM clash_kept WHERE user_id = ? AND a = ? AND b = ?", userId, a, b));
  }

  // --- лента уведомлений ---
  addNotice(userId: number, text: string, emotion: string, buttons = "", kind = ""): Promise<number> {
    return this.insert("INSERT INTO notices (user_id, text, emotion, buttons, at, kind) VALUES (?, ?, ?, ?, ?, ?)", userId, text, emotion, buttons, now(), kind);
  }
  /** Последние письма человека, от свежих к старым — для «Истории» (notices.ts). */
  noticesAll(userId: number, limit: number): Promise<NoticeRow[]> {
    return this.all<NoticeRow>("SELECT * FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT ?", userId, limit);
  }
  /** Самый большой номер письма во всей ленте (0 — писем нет): следующее письмо любого человека получит номер больше. */
  async noticeCursor(): Promise<number> {
    return Number((await this.get<{ n: number | string | null }>("SELECT MAX(id) AS n FROM notices"))?.n ?? 0);
  }
  noticesAfter(userId: number, afterId: number, limit = 20): Promise<NoticeRow[]> {
    return this.all<NoticeRow>("SELECT * FROM notices WHERE user_id = ? AND id > ? ORDER BY id DESC LIMIT ?", userId, afterId, limit);
  }
  async pruneNotices(userId: number, keep: number) {
    await this.run(
      "DELETE FROM notices WHERE user_id = ? AND id < (SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT ?) t)",
      userId, userId, keep,
    );
  }

  // --- push-подписки ---
  async addPushSub(s: { endpoint: string; userId: number; keys: unknown; label: string }) {
    await this.run(
      `INSERT INTO push_subs (endpoint, user_id, keys_json, label, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json, label = excluded.label`,
      s.endpoint, s.userId, JSON.stringify(s.keys), s.label, now(),
    );
  }
  pushSubsOf(userId: number): Promise<PushSub[]> {
    return this.all<PushSub>("SELECT * FROM push_subs WHERE user_id = ? ORDER BY created_at", userId);
  }
  async dropPushSub(endpoint: string) {
    await this.run("DELETE FROM push_subs WHERE endpoint = ?", endpoint);
  }
  async touchPushSub(endpoint: string) {
    await this.run("UPDATE push_subs SET last_ok = ? WHERE endpoint = ?", now(), endpoint);
  }
  allHabits(userId: number): Promise<HabitRow[]> {
    return this.all<HabitRow>("SELECT * FROM habits WHERE user_id = ? ORDER BY id", userId);
  }
  allDates(userId: number): Promise<DateRow[]> {
    return this.all<DateRow>("SELECT * FROM dates WHERE user_id = ? ORDER BY id", userId);
  }
  allMemory(userId: number): Promise<MemoryRow[]> {
    return this.all<MemoryRow>("SELECT * FROM memory WHERE user_id = ? ORDER BY id", userId);
  }
  async cancelReminders(refKind: string, refId: number) {
    await this.run("UPDATE reminders SET status = 'cancelled' WHERE ref_kind = ? AND ref_id = ? AND status = 'pending'", refKind, refId);
  }
  dueReminders(at: Date): Promise<ReminderRow[]> {
    return this.all<ReminderRow>("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at", at.toISOString());
  }
  pendingReminders(refKind: string, refId: number): Promise<ReminderRow[]> {
    return this.all<ReminderRow>("SELECT * FROM reminders WHERE ref_kind = ? AND ref_id = ? AND status = 'pending'", refKind, refId);
  }
  async markReminder(id: number, status: "sent" | "cancelled") {
    await this.run("UPDATE reminders SET status = ?, sent_at = ? WHERE id = ?", status, now(), id);
  }

  // --- активность ПК ---
  async upsertActivity(a: Omit<ActivityRow, "updated_at">) {
    await this.run(
      `INSERT INTO activity (user_id, day_key, source, active_sec, afk_sec, apps_json, games_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, day_key, source) DO UPDATE SET
         active_sec = excluded.active_sec, afk_sec = excluded.afk_sec, apps_json = excluded.apps_json,
         games_json = excluded.games_json, updated_at = excluded.updated_at`,
      a.user_id, a.day_key, a.source, a.active_sec, a.afk_sec, JSON.stringify(a.apps), JSON.stringify(a.games), now(),
    );
  }
  async activityOf(userId: number, dayKey: string): Promise<ActivityRow[]> {
    return (await this.all<Row>("SELECT * FROM activity WHERE user_id = ? AND day_key = ?", userId, dayKey)).map(toActivity);
  }
  async activityRange(userId: number, from: string, to: string): Promise<ActivityRow[]> {
    return (await this.all<Row>(
      "SELECT * FROM activity WHERE user_id = ? AND day_key BETWEEN ? AND ? ORDER BY day_key", userId, from, to,
    )).map(toActivity);
  }

  // --- иконки программ ---
  async dropIcon(userId: number, nameKey: string) {
    await this.run("DELETE FROM app_icons WHERE user_id = ? AND name_key = ?", userId, nameKey);
  }
  async setIcon(userId: number, nameKey: string, png: string) {
    await this.run(
      `INSERT INTO app_icons (user_id, name_key, png, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, name_key) DO UPDATE SET png = excluded.png, updated_at = excluded.updated_at`,
      userId, nameKey, png, now(),
    );
  }
  async icons(userId: number): Promise<{ name_key: string; png: string }[]> {
    return this.all("SELECT name_key, png FROM app_icons WHERE user_id = ?", userId);
  }

  // --- служебное ---
  /** Расход модели за месяц: запросов, токенов, денег. До шага 11 месяц копился в kv (llm:ГГГГ-ММ, без денег) — он прибавляется. */
  /** Итог месяца. userId — только расход этого человека (сайт, 24.11.2026); без него — весь сервер со старым счётчиком kv (админка, бот). */
  async llmUsage(month: string, userId?: number): Promise<{ calls: number; input: number; output: number; cost: number; priced: number }> {
    let old = { calls: 0, input: 0, output: 0 };
    if (userId === undefined) try { old = { ...old, ...JSON.parse((await this.kvGet(`llm:${month}`)) ?? "{}") }; } catch { /* битая запись — без неё */ }
    const mine = userId === undefined ? "" : " AND user_id = ?";
    const r = await this.get<Record<string, unknown>>(
      `SELECT SUM(calls) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(micro_usd) AS micro, SUM(priced) AS priced FROM llm_usage WHERE day LIKE ?${mine}`,
      `${month}-%`, ...(userId === undefined ? [] : [userId]),
    );
    const n = (v: unknown) => Number(v ?? 0) || 0;
    return { calls: old.calls + n(r?.calls), input: old.input + n(r?.input), output: old.output + n(r?.output), cost: n(r?.micro) / 1e6, priced: n(r?.priced) };
  }
  /** Один запрос к модели (или картинка, или голосовое) — в строку своего дня, назначения и модели. cost — доллары или null. */
  async addUsage(at: Date, x: { kind: string; model: string; input: number; output: number; cost: number | null; userId?: number }) {
    const micro = x.cost == null ? 0 : Math.round(x.cost * 1e6);
    await this.run(
      `INSERT INTO llm_usage (day, user_id, kind, model, calls, input, output, micro_usd, priced) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (day, user_id, kind, model) DO UPDATE SET calls = llm_usage.calls + 1, input = llm_usage.input + excluded.input,
       output = llm_usage.output + excluded.output, micro_usd = llm_usage.micro_usd + excluded.micro_usd, priced = llm_usage.priced + excluded.priced`,
      at.toISOString().slice(0, 10), x.userId ?? 0, x.kind, x.model.slice(0, 120), Math.max(0, Math.round(x.input)), Math.max(0, Math.round(x.output)), micro,
      x.cost == null ? 0 : 1,
    );
  }
  /** Одна попытка запроса к модели (рисованию, голосу): время ответа, цена, короткий код ошибки (пусто — удачно). Без текстов. */
  async addLlmCall(at: Date, x: { kind: string; model: string; ms: number; cost: number | null; error?: string; userId?: number }) {
    await this.run(
      "INSERT INTO llm_calls (at, user_id, kind, model, ms, micro_usd, error_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
      at.toISOString(), x.userId ?? 0, x.kind, x.model.slice(0, 120), Math.max(0, Math.round(x.ms)),
      x.cost == null ? 0 : Math.round(x.cost * 1e6), (x.error ?? "").slice(0, 20),
    );
  }
  /** Расход по дням с from по to (ГГГГ-ММ-ДД, включительно), по дням и назначениям. userId — только этого человека, без него — все вместе. */
  async usageDays(from: string, to: string, userId?: number): Promise<UsageRow[]> {
    const mine = userId === undefined ? "" : " AND user_id = ?";
    const rows = await this.all<Record<string, unknown>>(
      `SELECT day, kind, model, SUM(calls) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(micro_usd) AS micro_usd, SUM(priced) AS priced
       FROM llm_usage WHERE day >= ? AND day <= ?${mine} GROUP BY day, kind, model ORDER BY day, kind, model`, from, to, ...(userId === undefined ? [] : [userId]),
    );
    return rows.map((r) => ({
      day: String(r.day), kind: String(r.kind), model: String(r.model), calls: Number(r.calls), input: Number(r.input),
      output: Number(r.output), cost: Number(r.micro_usd) / 1e6, priced: Number(r.priced),
    }));
  }
  /** Аккаунты для владельца (/accounts): кто когда писал, сколько сообщений с since (ISO), расход за месяц (ГГГГ-ММ) и всего.
   *  Строка с id 0 — расход ничей или записанный до учёта по людям. */
  async accounts(month: string, since: string): Promise<AccountRow[]> {
    const users = await this.all<Record<string, unknown>>(
      `SELECT u.id, u.name, u.login, u.chat_id, u.created_at,
         (SELECT MAX(received_at) FROM messages m WHERE m.user_id = u.id) AS last_at,
         (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.received_at >= ?) AS recent
       FROM users u ORDER BY u.id`, since,
    );
    const spent = await this.all<Record<string, unknown>>(
      "SELECT user_id, SUM(micro_usd) AS total, SUM(CASE WHEN day LIKE ? THEN micro_usd ELSE 0 END) AS month FROM llm_usage GROUP BY user_id", `${month}-%`,
    );
    const cost = new Map(spent.map((r) => [Number(r.user_id), { month: Number(r.month ?? 0) / 1e6, total: Number(r.total ?? 0) / 1e6 }]));
    const rows: AccountRow[] = users.map((u) => ({
      id: Number(u.id), name: String(u.name ?? ""), login: u.login == null ? null : String(u.login), chat_id: u.chat_id == null ? null : String(u.chat_id),
      created_at: String(u.created_at ?? ""), last_at: u.last_at == null ? null : String(u.last_at), recent: Number(u.recent ?? 0),
      month: cost.get(Number(u.id))?.month ?? 0, total: cost.get(Number(u.id))?.total ?? 0,
    }));
    const nobody = cost.get(0);
    if (nobody && nobody.total > 0) rows.push({ id: 0, name: "", login: null, chat_id: null, created_at: "", last_at: null, recent: 0, ...nobody });
    return rows;
  }
  async kvGet(key: string): Promise<string | undefined> {
    return (await this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key))?.value;
  }
  // ——— Админка, этап 1 (admin-stats.ts): только счётчики, без текстов. Обращения к горничной — сообщения, которые разбирает
  // модель (ADMIN_AI_SQL); «без ИИ» — отметки кнопкой, из push и правки мышью (ADMIN_MANUAL_SQL). Импорт прошлого — не в счёт.
  /** По людям: всего, последнее, за 30 дней — всего, с ИИ, без ИИ; отменённые за 30 дней.
   *  С ИИ / без (этап 2): сообщение прошло разбор после шага 24 (route не пуст) — по messages.llm_calls (> 0 — с ИИ, 0 — без:
   *  погода и т. п.); старые и не через разбор (route пуст: кнопки, push, правки мышью) — по источнику, как на этапе 1
   *  (ADMIN_AI_SQL / ADMIN_MANUAL_SQL). Поправки к ответам — ни там ни там (их считает «Качество разбора»). */
  async adminUserStats(since: string): Promise<{ user_id: number; total: number; last_at: string | null; n30: number; ai30: number; manual30: number; undone30: number }[]> {
    const routed = "(m.route <> '' AND m.source_id NOT LIKE 'correct:%')";
    const rows = await this.all<Record<string, unknown>>(
      `SELECT m.user_id, COUNT(*) AS total, MAX(m.received_at) AS last_at,
         SUM(CASE WHEN m.received_at >= ? THEN 1 ELSE 0 END) AS n30,
         SUM(CASE WHEN m.received_at >= ? AND ((${routed} AND m.llm_calls > 0) OR (m.route = '' AND ${ADMIN_AI_SQL})) THEN 1 ELSE 0 END) AS ai30,
         SUM(CASE WHEN m.received_at >= ? AND ((${routed} AND m.llm_calls = 0) OR (m.route = '' AND ${ADMIN_MANUAL_SQL})) THEN 1 ELSE 0 END) AS manual30
       FROM messages m WHERE m.source <> 'import' GROUP BY m.user_id`, since, since, since,
    );
    const undone = await this.all<Record<string, unknown>>(
      "SELECT user_id, COUNT(DISTINCT message_id) AS n FROM actions WHERE undone = 1 AND created_at >= ? GROUP BY user_id", since,
    );
    const undoneBy = new Map(undone.map((r) => [Number(r.user_id), Number(r.n ?? 0)]));
    return rows.map((r) => ({ user_id: Number(r.user_id), total: Number(r.total), last_at: r.last_at == null ? null : String(r.last_at), n30: Number(r.n30 ?? 0),
      ai30: Number(r.ai30 ?? 0), manual30: Number(r.manual30 ?? 0), undone30: undoneBy.get(Number(r.user_id)) ?? 0 }));
  }
  /** Кто в какие дни (день по поясу человека) обращался — для активных за день/неделю/месяц, удержания и оттока. */
  async adminActiveDays(fromDay: string): Promise<{ day: string; user_id: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT DISTINCT m.day_key AS day, m.user_id FROM messages m WHERE m.day_key >= ? AND m.source <> 'import' AND (${ADMIN_AI_SQL} OR ${ADMIN_MANUAL_SQL})
       ORDER BY m.day_key`, fromDay,
    );
    return rows.map((r) => ({ day: String(r.day), user_id: Number(r.user_id) }));
  }
  /** Качество разбора по дням (обращения к модели): всего, сейчас не разобрано (failed), сейчас ждут ответа (clarify),
   *  поправок к ответам, отменённых. failed/clarify — нынешнее состояние сообщения: разобранное позже из счёта уходит. */
  async adminQuality(fromDay: string): Promise<{ day: string; requests: number; failed: number; clarify: number; corrections: number; undone: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT m.day_key AS day,
         SUM(CASE WHEN ${ADMIN_AI_SQL} THEN 1 ELSE 0 END) AS requests,
         SUM(CASE WHEN ${ADMIN_AI_SQL} AND m.state = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN ${ADMIN_AI_SQL} AND m.state = 'clarify' THEN 1 ELSE 0 END) AS clarify,
         SUM(CASE WHEN m.source_id LIKE 'correct:%' THEN 1 ELSE 0 END) AS corrections,
         SUM(CASE WHEN ${ADMIN_AI_SQL} AND u.message_id IS NOT NULL THEN 1 ELSE 0 END) AS undone
       FROM messages m LEFT JOIN (SELECT DISTINCT message_id FROM actions WHERE undone = 1) u ON u.message_id = m.id
       WHERE m.day_key >= ? AND m.source <> 'import' GROUP BY m.day_key ORDER BY m.day_key`, fromDay,
    );
    const n = (v: unknown) => Number(v ?? 0) || 0;
    return rows.map((r) => ({ day: String(r.day), requests: n(r.requests), failed: n(r.failed), clarify: n(r.clarify), corrections: n(r.corrections), undone: n(r.undone) }));
  }
  /** Откуда пишут с since: источник сообщения, сколько сообщений и сколько людей. */
  async adminSources(since: string): Promise<{ source: string; messages: number; users: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT m.source, COUNT(*) AS messages, COUNT(DISTINCT m.user_id) AS users FROM messages m
       WHERE m.received_at >= ? AND m.source <> 'import' GROUP BY m.source ORDER BY COUNT(*) DESC`, since,
    );
    return rows.map((r) => ({ source: String(r.source), messages: Number(r.messages), users: Number(r.users) }));
  }
  /** Расход по людям с from по to (дни UTC, как llm_usage): всего и фоновый (сводки, поиск связей — не по просьбе человека). */
  async adminSpendByUser(from: string, to: string): Promise<{ user_id: number; calls: number; cost: number; background: number; priced: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT user_id, SUM(calls) AS calls, SUM(micro_usd) AS micro, SUM(CASE WHEN kind IN ('summary', 'patterns') THEN micro_usd ELSE 0 END) AS bg,
         SUM(priced) AS priced FROM llm_usage WHERE day >= ? AND day <= ? GROUP BY user_id`, from, to,
    );
    return rows.map((r) => ({ user_id: Number(r.user_id), calls: Number(r.calls), cost: Number(r.micro) / 1e6, background: Number(r.bg ?? 0) / 1e6, priced: Number(r.priced) }));
  }
  /** Сколько сообщений сейчас не разобрано (state failed) с since — для тревоги владельцу. */
  async adminFailedSince(since: string): Promise<number> {
    return Number((await this.get<{ n: unknown }>("SELECT COUNT(*) AS n FROM messages WHERE state = 'failed' AND received_at >= ?", since))?.n ?? 0);
  }
  // ——— Админка, этап 2 (admin-stats.ts): входы, минуты присутствия, вызовы модели — счётчики, без текстов и chat id.
  /** Входы, которыми пользовались с since: человек, клиент и версия (пусто — старый клиент без заголовка), метка, когда. */
  async adminSessions(since: string): Promise<{ user_id: number; client: string; version: string; label: string; last_seen: string }[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT user_id, client, version, label, last_seen FROM sessions WHERE last_seen >= ?", since);
    return rows.map((r) => ({ user_id: Number(r.user_id), client: String(r.client ?? ""), version: String(r.version ?? ""), label: String(r.label ?? ""), last_seen: String(r.last_seen) }));
  }
  /** Минуты присутствия с fromDay по дням и часам — сумма по всем людям и клиентам (сводно, не по человеку). */
  async adminPresenceHeat(fromDay: string): Promise<{ day: string; hour: number; minutes: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT day_key AS day, hour, SUM(minutes) AS minutes FROM presence WHERE day_key >= ? GROUP BY day_key, hour", fromDay,
    );
    return rows.map((r) => ({ day: String(r.day), hour: Number(r.hour), minutes: Number(r.minutes ?? 0) }));
  }
  /** С каких клиентов заходили с fromDay: сколько людей и минут. */
  async adminPresenceClients(fromDay: string): Promise<{ client: string; users: number; minutes: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT client, COUNT(DISTINCT user_id) AS users, SUM(minutes) AS minutes FROM presence WHERE day_key >= ? GROUP BY client ORDER BY COUNT(DISTINCT user_id) DESC", fromDay,
    );
    return rows.map((r) => ({ client: String(r.client), users: Number(r.users), minutes: Number(r.minutes ?? 0) }));
  }
  /** Кто заходил с клиента client в эти дни (day_key) — с часом, чтобы сверить с «сейчас» по поясу человека. */
  async adminPresenceUsers(client: string, days: string[]): Promise<{ user_id: number; day: string; hour: number }[]> {
    if (!days.length) return [];
    const rows = await this.all<Record<string, unknown>>(
      `SELECT user_id, day_key AS day, hour FROM presence WHERE client = ? AND day_key IN (${days.map(() => "?").join(", ")})`, client, ...days,
    );
    return rows.map((r) => ({ user_id: Number(r.user_id), day: String(r.day), hour: Number(r.hour) }));
  }
  /** Сообщения с since, на которые ушло больше всего вызовов модели (messages.llm_calls, шаг 24): кто, когда, ветка — без текста. */
  async adminHeavyMessages(since: string, limit = 20): Promise<{ user_id: number; received_at: string; source: string; route: string; llm_calls: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT user_id, received_at, source, route, llm_calls FROM messages WHERE received_at >= ? AND llm_calls > 0
       ORDER BY llm_calls DESC, received_at DESC LIMIT ?`, since, limit,
    );
    return rows.map((r) => ({ user_id: Number(r.user_id), received_at: String(r.received_at), source: String(r.source), route: String(r.route), llm_calls: Number(r.llm_calls) }));
  }
  /** Ветки разбора с since (только сообщения, прошедшие разбор после шага 24): сколько сообщений и вызовов модели. */
  async adminRoutes(since: string): Promise<{ route: string; messages: number; calls: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT route, COUNT(*) AS messages, SUM(llm_calls) AS calls FROM messages WHERE received_at >= ? AND route <> '' GROUP BY route ORDER BY SUM(llm_calls) DESC", since,
    );
    return rows.map((r) => ({ route: String(r.route), messages: Number(r.messages), calls: Number(r.calls ?? 0) }));
  }
  /** Попытки модели с since по назначению и коду ошибки (пусто — удачные); day — из них с daySince. */
  async adminLlmErrors(since: string, daySince: string): Promise<{ kind: string; error_code: string; week: number; day: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT kind, error_code, COUNT(*) AS week, SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS day FROM llm_calls WHERE at >= ? GROUP BY kind, error_code", daySince, since,
    );
    return rows.map((r) => ({ kind: String(r.kind), error_code: String(r.error_code), week: Number(r.week), day: Number(r.day ?? 0) }));
  }
  /** Время удачных ответов модели с since (последние limit попыток) — перцентили считает admin-stats.ts. */
  async adminLlmTimes(since: string, limit = 10_000): Promise<{ at: string; model: string; ms: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT at, model, ms FROM llm_calls WHERE at >= ? AND error_code = '' ORDER BY id DESC LIMIT ?", since, limit,
    );
    return rows.map((r) => ({ at: String(r.at), model: String(r.model), ms: Number(r.ms) }));
  }
  /** Сообщения, которые сейчас не разобраны (failed) и ждут уточнения (clarify); failed24 — из них за сутки, которые ещё повторяются
   *  (упавший разговор — reply с префиксом noRetry, pipeline.ts CHAT_FAILED — фоновый повтор пропускает). */
  async adminStuckMessages(daySince: string, noRetry: string): Promise<{ failed: number; clarify: number; failed24: number }> {
    const r = await this.get<Record<string, unknown>>(
      `SELECT SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN state = 'clarify' THEN 1 ELSE 0 END) AS clarify,
         SUM(CASE WHEN state = 'failed' AND received_at >= ? AND COALESCE(reply, '') NOT LIKE ? THEN 1 ELSE 0 END) AS failed24
       FROM messages WHERE state IN ('failed', 'clarify')`, daySince, `${noRetry}%`,
    );
    return { failed: Number(r?.failed ?? 0), clarify: Number(r?.clarify ?? 0), failed24: Number(r?.failed24 ?? 0) };
  }
  /** Напоминания, которые ждут отправки со сроком не позже before: сколько и самое старое (в норме 0 — такт планировщика идёт). */
  async adminOverdueReminders(before: string): Promise<{ n: number; oldest: string | null }> {
    const r = await this.get<Record<string, unknown>>("SELECT COUNT(*) AS n, MIN(due_at) AS oldest FROM reminders WHERE status = 'pending' AND due_at <= ?", before);
    return { n: Number(r?.n ?? 0), oldest: r?.oldest == null ? null : String(r.oldest) };
  }
  async kvDel(key: string) {
    await this.run("DELETE FROM kv WHERE key = ?", key);
  }
  /** Журнал админки (admin.ts): detail — параметры (номера аккаунтов и числа, без имён), reason — причина (шаг 33). */
  async addAdminLog(userId: number, action: string, detail = "", at = new Date(), reason = "") {
    await this.run("INSERT INTO admin_log (at, user_id, action, detail, reason) VALUES (?, ?, ?, ?, ?)",
      at.toISOString(), userId, action, detail.slice(0, 200), reason.slice(0, 300));
  }
  /** Последние строки журнала; target — только про этот аккаунт (detail начинается с «#<номер> » или равен «#<номер>»). */
  async adminLog(limit = 100, target?: number): Promise<{ at: string; user_id: number; action: string; detail: string; reason: string }[]> {
    const rows = target == null
      ? await this.all<Record<string, unknown>>("SELECT at, user_id, action, detail, reason FROM admin_log ORDER BY id DESC LIMIT ?", limit)
      : await this.all<Record<string, unknown>>(
        "SELECT at, user_id, action, detail, reason FROM admin_log WHERE detail = ? OR detail LIKE ? ORDER BY id DESC LIMIT ?", `#${target}`, `#${target} %`, limit,
      );
    return rows.map((r) => ({ at: String(r.at), user_id: Number(r.user_id), action: String(r.action), detail: String(r.detail ?? ""), reason: String(r.reason ?? "") }));
  }
  /** Журнал подписки одного человека, новые сверху (карточка аккаунта в админке). */
  async billingEventsOf(userId: number, limit = 50): Promise<BillingEventRow[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT id, user_id, at, kind, charge_id, amount FROM billing_events WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?", userId, limit,
    );
    return rows.map((r) => ({
      id: Number(r.id), user_id: Number(r.user_id), at: String(r.at), kind: String(r.kind) as BillingKind,
      charge_id: r.charge_id == null ? null : String(r.charge_id), amount: r.amount == null ? null : Number(r.amount),
    }));
  }
  /** Активность одного человека по дням для карточки аккаунта — только счётчики: сообщения с ИИ и без (по его дню, как
   *  analyticsActiveDays), минуты присутствия (его день), вызовы модели и расход (день UTC, llm_usage). Дни — fromDay..toDay. */
  async accountDays(userId: number, fromDay: string, toDay: string): Promise<{ day: string; ai: number; manual: number; minutes: number; calls: number; micro: number }[]> {
    const out = new Map<string, { day: string; ai: number; manual: number; minutes: number; calls: number; micro: number }>();
    const at = (d: string) => out.get(d) ?? out.set(d, { day: d, ai: 0, manual: 0, minutes: 0, calls: 0, micro: 0 }).get(d)!;
    for (const r of await this.all<Record<string, unknown>>(
      `SELECT m.day_key AS day, SUM(CASE WHEN ${ADMIN_AI_SQL} THEN 1 ELSE 0 END) AS ai, SUM(CASE WHEN ${ADMIN_MANUAL_SQL} THEN 1 ELSE 0 END) AS manual
       FROM messages m WHERE m.user_id = ? AND m.day_key >= ? AND m.day_key <= ? AND m.source <> 'import' GROUP BY m.day_key`, userId, fromDay, toDay,
    )) Object.assign(at(String(r.day)), { ai: Number(r.ai) || 0, manual: Number(r.manual) || 0 });
    for (const r of await this.all<Record<string, unknown>>(
      "SELECT day_key AS day, SUM(minutes) AS n FROM presence WHERE user_id = ? AND day_key >= ? AND day_key <= ? GROUP BY day_key", userId, fromDay, toDay,
    )) at(String(r.day)).minutes = Number(r.n) || 0;
    for (const r of await this.all<Record<string, unknown>>(
      "SELECT day, SUM(calls) AS calls, SUM(micro_usd) AS micro FROM llm_usage WHERE user_id = ? AND day >= ? AND day <= ? GROUP BY day", userId, fromDay, toDay,
    )) Object.assign(at(String(r.day)), { calls: Number(r.calls) || 0, micro: Number(r.micro) || 0 });
    return [...out.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
  /** Входы человека для карточки: клиент, версия, когда (без меток входа и ключей). */
  async accountSessions(userId: number): Promise<{ client: string; version: string; last_seen: string }[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT client, version, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC", userId);
    return rows.map((r) => ({ client: String(r.client ?? ""), version: String(r.version ?? ""), last_seen: String(r.last_seen) }));
  }
  /** Закрыть все входы человека (заморозка аккаунта). Сколько закрыто. */
  async dropSessionsOf(userId: number): Promise<number> {
    return this.run("DELETE FROM sessions WHERE user_id = ?", userId);
  }
  /** Удалить человека id (админка, admin-account.ts delete) одной транзакцией: ключи kv с его номером и номерами его строк, все
   *  строки ACCOUNT_TABLES (и отметки его привычек), деньги — отвязать (ACCOUNT_DETACH_TABLES), потом саму запись users. Сбой на
   *  любом шаге — откат всего. deleted — сколько строк удалено, detached — сколько отвязано; extra — в той же транзакции после
   *  (строка журнала админа: не записалась — не удалено ничего). */
  async deleteAccount(id: number, extra: ((n: { deleted: number; detached: number }) => Promise<void>) | null = null): Promise<{ deleted: number; detached: number }> {
    return this.transaction(async () => {
      let deleted = 0, detached = 0;
      const del = async (sql: string, ...args: unknown[]) => { deleted += await this.run(sql, ...args); };
      // Отметка /paysupport (bot.ts) — по Telegram id, не по номеру: взять его, пока запись users есть (в личке chat_id = tg id).
      const me = await this.get<{ chat_id: unknown; tg_user_id: unknown }>("SELECT chat_id, tg_user_id FROM users WHERE id = ?", id);
      for (const t of new Set([me?.tg_user_id, me?.chat_id].map((x) => String(x ?? "")).filter(Boolean))) await del("DELETE FROM kv WHERE key LIKE ?", `paysupport:${t}:%`);
      // kv по строкам человека — пока строки есть: долг разбора и повтор (по сообщению), раскладка серии (по плану), отметки
      // «уже напомнила» о датах и привычках (по строке).
      await del(
        `DELETE FROM kv WHERE key IN (SELECT ('owe:' || id) FROM messages WHERE user_id = ?) OR key IN (SELECT ('retry:' || id) FROM messages WHERE user_id = ?)
          OR key IN (SELECT ('series:' || id || ':laid') FROM events WHERE user_id = ?)
          OR EXISTS (SELECT 1 FROM dates d WHERE d.user_id = ? AND kv.key LIKE ('date:' || d.id || ':%'))
          OR EXISTS (SELECT 1 FROM habits h WHERE h.user_id = ? AND kv.key LIKE ('habit:' || h.id || ':%'))`,
        id, id, id, id, id,
      );
      const exact = USER_KV_EXACT.map((p) => `${p}:${id}`);
      await del(`DELETE FROM kv WHERE key IN (${exact.map(() => "?").join(", ")})`, ...exact);
      for (const p of USER_KV_PREFIX) await del("DELETE FROM kv WHERE key LIKE ? AND key NOT LIKE '%:laid'", `${p}:${id}:%`);
      await del("DELETE FROM habit_marks WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ?)", id);
      for (const t of ACCOUNT_TABLES) await del(`DELETE FROM ${t} WHERE user_id = ?`, id);
      detached += await this.run("UPDATE payments SET user_id = ?, tg_user_id = '' WHERE user_id = ?", -id, id);
      detached += await this.run("UPDATE billing_events SET user_id = ? WHERE user_id = ?", -id, id);
      detached += await this.run(
        `INSERT INTO llm_usage (day, user_id, kind, model, calls, input, output, micro_usd, priced)
          SELECT day, 0, kind, model, calls, input, output, micro_usd, priced FROM llm_usage WHERE user_id = ?
          ON CONFLICT (day, user_id, kind, model) DO UPDATE SET calls = llm_usage.calls + excluded.calls, input = llm_usage.input + excluded.input,
            output = llm_usage.output + excluded.output, micro_usd = llm_usage.micro_usd + excluded.micro_usd, priced = llm_usage.priced + excluded.priced`,
        id,
      );
      await this.run("DELETE FROM llm_usage WHERE user_id = ?", id);
      detached += await this.run("UPDATE llm_calls SET user_id = 0 WHERE user_id = ?", id);
      deleted += await this.run("DELETE FROM users WHERE id = ?", id);
      const gone = Number((await this.kvGet(USERS_GONE_KEY)) ?? 0);
      if (id > gone) await this.kvSet(USERS_GONE_KEY, String(id));
      if (extra) await extra({ deleted, detached });
      return { deleted, detached };
    });
  }
  /** Хвосты удалённых (номер ≤ USERS_GONE_KEY, записи users нет): то, что дописали уже начатые до удаления дела — разбор сообщения
   *  после ответа модели, обход планировщика по старому списку, пачка счётчиков фич. Удаляются так же, как в deleteAccount: строки
   *  ACCOUNT_TABLES, отметки привычек, ключи kv с номером человека и номерами его строк (и долги разбора по уже удалённым
   *  сообщениям); деньги — отвязать (оплаты и журнал подписки — на −id, расход модели — на 0). Зовётся через 2 минуты после
   *  удаления (admin-account.ts) и раз в сутки (scheduler.ts). Удалений не было — ничего. Сколько строк убрано и отвязано. */
  async sweepOrphans(): Promise<number> {
    const max = Number((await this.kvGet(USERS_GONE_KEY)) ?? 0);
    if (!(max > 0)) return 0;
    // Ключи kv — до списка живых: ключ нового человека появляется только после его записи users.
    const exact = new Set<string>(USER_KV_EXACT);
    const userKeys = await this.all<{ key: string }>(
      `SELECT key FROM kv WHERE ${[...USER_KV_EXACT, ...USER_KV_PREFIX, "owe", "retry"].map(() => "key LIKE ?").join(" OR ")}`,
      ...[...USER_KV_EXACT, ...USER_KV_PREFIX, "owe", "retry"].map((p) => `${p}:%`),
    );
    const live = new Set((await this.all<{ id: number }>("SELECT id FROM users")).map((r) => Number(r.id)));
    const msgs = new Set((await this.all<{ id: number }>("SELECT id FROM messages")).map((r) => Number(r.id)));
    const gone = (n: number) => n > 0 && n <= max && !live.has(n);
    const stale: string[] = [];
    for (const { key } of userKeys) {
      if (/^(owe|retry):\d+$/.test(key)) {
        if (!msgs.has(Number(key.slice(key.indexOf(":") + 1)))) stale.push(key);
        continue;
      }
      for (const p of [...USER_KV_EXACT, ...USER_KV_PREFIX]) {
        if (!key.startsWith(`${p}:`)) continue;
        const m = /^(\d+)(:.*)?$/.exec(key.slice(p.length + 1));
        if (m && (exact.has(p) ? !m[2] : Boolean(m[2]) && !m[2].endsWith(":laid")) && gone(Number(m[1]))) stale.push(key);
      }
    }
    return this.transaction(async () => {
      let n = 0;
      const orphan = (t: string) => `${t}.user_id > 0 AND ${t}.user_id <= ${max} AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = ${t}.user_id)`;
      for (const k of stale) n += await this.run("DELETE FROM kv WHERE key = ?", k);
      n += await this.run(
        `DELETE FROM kv WHERE key IN (SELECT ('owe:' || id) FROM messages WHERE ${orphan("messages")}) OR key IN (SELECT ('retry:' || id) FROM messages WHERE ${orphan("messages")})
          OR key IN (SELECT ('series:' || id || ':laid') FROM events WHERE ${orphan("events")})
          OR EXISTS (SELECT 1 FROM dates WHERE ${orphan("dates")} AND kv.key LIKE ('date:' || dates.id || ':%'))
          OR EXISTS (SELECT 1 FROM habits WHERE ${orphan("habits")} AND kv.key LIKE ('habit:' || habits.id || ':%'))`,
      );
      n += await this.run(`DELETE FROM habit_marks WHERE habit_id IN (SELECT id FROM habits WHERE ${orphan("habits")})`);
      for (const t of ACCOUNT_TABLES) n += await this.run(`DELETE FROM ${t} WHERE ${orphan(t)}`);
      n += await this.run(`UPDATE payments SET user_id = -user_id, tg_user_id = '' WHERE ${orphan("payments")}`);
      n += await this.run(`UPDATE billing_events SET user_id = -user_id WHERE ${orphan("billing_events")}`);
      n += await this.run(
        `INSERT INTO llm_usage (day, user_id, kind, model, calls, input, output, micro_usd, priced)
          SELECT day, 0, kind, model, SUM(calls), SUM(input), SUM(output), SUM(micro_usd), SUM(priced) FROM llm_usage WHERE ${orphan("llm_usage")} GROUP BY day, kind, model
          ON CONFLICT (day, user_id, kind, model) DO UPDATE SET calls = llm_usage.calls + excluded.calls, input = llm_usage.input + excluded.input,
            output = llm_usage.output + excluded.output, micro_usd = llm_usage.micro_usd + excluded.micro_usd, priced = llm_usage.priced + excluded.priced`,
      );
      await this.run(`DELETE FROM llm_usage WHERE ${orphan("llm_usage")}`);
      n += await this.run(`UPDATE llm_calls SET user_id = 0 WHERE ${orphan("llm_calls")}`);
      return n;
    });
  }
  // ——— Тарифы из базы (шаг 30, tariffs.ts): изменённые числа и история «Применить» / откат / /signups.
  /** Изменённые числа тарифов: key → value (JSON). Нет строки — значение по умолчанию. */
  async tariffSettings(): Promise<{ key: string; value: string }[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT key, value FROM tariff_settings ORDER BY key");
    return rows.map((r) => ({ key: String(r.key), value: String(r.value) }));
  }
  /** Записать числа и строку истории одним разом: value — JSON, null — убрать строку (снова по умолчанию). Номер строки истории. */
  async saveTariffs(set: { key: string; value: string | null }[], h: Omit<TariffHistoryRow, "id">): Promise<number> {
    return this.driver.tx(async () => {
      for (const x of set) {
        if (x.value === null) await this.run("DELETE FROM tariff_settings WHERE key = ?", x.key);
        else {
          await this.run(
            "INSERT INTO tariff_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            x.key, x.value, h.at, h.user_id,
          );
        }
      }
      return this.insert(
        "INSERT INTO tariff_history (at, user_id, source, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?)",
        h.at, h.user_id, h.source, h.before_json, h.after_json, h.reason.slice(0, 300),
      );
    });
  }
  /** История тарифов, новые сверху. */
  async tariffHistory(limit = 50): Promise<TariffHistoryRow[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT * FROM tariff_history ORDER BY id DESC LIMIT ?", limit);
    return rows.map(tariffRow);
  }
  async tariffHistoryRow(id: number): Promise<TariffHistoryRow | undefined> {
    const r = await this.get<Record<string, unknown>>("SELECT * FROM tariff_history WHERE id = ?", id);
    return r ? tariffRow(r) : undefined;
  }
  /** Расход ИИ по людям и дням (UTC) с day >= since — у тех, чей план сейчас plans (экономика тарифа, tariffs.ts): человек × день → микро$
   *  с оценкой est за вызовы без цены, как у потолков. */
  async planDaySpend(since: string, plans: string[], est: Unpriced = NO_EST): Promise<{ user_id: number; plan: string; day: string; micro: number }[]> {
    if (!plans.length) return [];
    const rows = await this.all<Record<string, unknown>>(
      `SELECT u.user_id AS user_id, p.plan AS plan, u.day AS day, SUM(u.micro_usd + ${UNPRICED_SQL}) AS micro
       FROM llm_usage u JOIN users p ON p.id = u.user_id
       WHERE u.day >= ? AND p.plan IN (${plans.map(() => "?").join(", ")})
       GROUP BY u.user_id, p.plan, u.day`,
      ...microOf(est), since, ...plans,
    );
    return rows.map((r) => ({ user_id: Number(r.user_id), plan: String(r.plan), day: String(r.day), micro: Number(r.micro ?? 0) }));
  }
  async kvSet(key: string, value: string) {
    await this.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }
  /** Поставить отметку один раз; true — если её ещё не было. */
  /** Отметки «уже отправлено» (once), поставленные раньше before, — удалить: таблица иначе только растёт. Возвращает, сколько удалено. */
  pruneOnce(before: Date): Promise<number> {
    const kinds = ["habit", "backup", "game", "morning", "date", "tomorrow", "evening", "escapes", "series", "prune", "snapshot", "patterns", "rain", "alert", "billing", "subend", "digest", "paysupport"];
    return this.run(
      `DELETE FROM kv WHERE value < ? AND (${kinds.map(() => "key LIKE ?").join(" OR ")})`,
      before.toISOString(), ...kinds.map((k) => `${k}:%`),
    );
  }
  /** Раз в сутки: минуты присутствия и счётчики фич старше 400 дней (по day_key; присутствие — с 24.11.2026, раньше 90: годовые
   *  когорты удержания), журнал попыток модели старше 30 дней, счётчики лимитов в штуках (ai_quota) старше 40 дней, журнал
   *  оповещений и копий базы старше 180 дней. */
  async pruneStats(at: Date) {
    await this.run("DELETE FROM presence WHERE day_key < ?", new Date(at.getTime() - 400 * 86_400_000).toISOString().slice(0, 10));
    await this.run("DELETE FROM llm_calls WHERE at < ?", new Date(at.getTime() - 30 * 86_400_000).toISOString());
    await this.run("DELETE FROM feature_events WHERE day_key < ?", new Date(at.getTime() - 400 * 86_400_000).toISOString().slice(0, 10));
    await this.run("DELETE FROM ai_quota WHERE day_key < ?", new Date(at.getTime() - 40 * 86_400_000).toISOString().slice(0, 10));
    // Журнал оповещений и копий базы (шаг 34) — 180 дней.
    await this.run("DELETE FROM alert_log WHERE at < ?", new Date(at.getTime() - 180 * 86_400_000).toISOString());
    await this.run("DELETE FROM db_copies WHERE at < ?", new Date(at.getTime() - 180 * 86_400_000).toISOString());
    // Падения виджета и дни программы по версиям (шаг 35) — 90 дней.
    const crashDay = new Date(at.getTime() - CRASH_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    await this.run("DELETE FROM crash_events WHERE day_key < ?", crashDay);
    await this.run("DELETE FROM desktop_days WHERE day_key < ?", crashDay);
  }
  // ——— Падения виджета и версии программы по дням (шаг 35, crashes.ts).
  /** Человек был в этот день с этой версией программы; crashes — сколько падений прибавить (0 — просто был). */
  async markDesktopDay(userId: number, day: string, version: string, crashes = 0) {
    await this.run(
      `INSERT INTO desktop_days (user_id, day_key, version, crashes) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, day_key, version) DO UPDATE SET crashes = desktop_days.crashes + excluded.crashes`,
      userId, day, version.slice(0, 20), crashes,
    );
  }
  /** Прибавить падения к строкам день × версия × процесс × тип × место × отпечаток (одной транзакцией). */
  async addCrashEvents(rows: CrashEventRow[]) {
    if (!rows.length) return;
    await this.transaction(async () => {
      for (const r of rows) {
        await this.run(
          `INSERT INTO crash_events (day_key, version, process, kind, place, fingerprint, count, users) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (day_key, version, process, kind, place, fingerprint)
           DO UPDATE SET count = crash_events.count + excluded.count, users = crash_events.users + excluded.users`,
          r.day_key, r.version, r.process, r.kind, r.place, r.fingerprint, r.count, r.users,
        );
      }
    });
  }
  /** По версиям с fromDay: людей с этой версией, из них с падением, падений всего. */
  async crashVersions(fromDay: string): Promise<{ version: string; active: number; crashed: number; crashes: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT version, COUNT(DISTINCT user_id) AS active, COUNT(DISTINCT CASE WHEN crashes > 0 THEN user_id END) AS crashed,
        SUM(crashes) AS crashes FROM desktop_days WHERE day_key >= ? GROUP BY version`, fromDay,
    );
    return rows.map((r) => ({ version: String(r.version), active: Number(r.active), crashed: Number(r.crashed ?? 0), crashes: Number(r.crashes ?? 0) }));
  }
  /** По дням с fromDay (все версии): людей с программой, из них с падением, падений. */
  async crashDays(fromDay: string): Promise<{ day: string; active: number; crashed: number; crashes: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT day_key AS day, COUNT(DISTINCT user_id) AS active, COUNT(DISTINCT CASE WHEN crashes > 0 THEN user_id END) AS crashed,
        SUM(crashes) AS crashes FROM desktop_days WHERE day_key >= ? GROUP BY day_key ORDER BY day_key`, fromDay,
    );
    return rows.map((r) => ({ day: String(r.day), active: Number(r.active), crashed: Number(r.crashed ?? 0), crashes: Number(r.crashes ?? 0) }));
  }
  /** Места падений с fromDay: по версии, процессу, типу, месту и отпечатку — сколько раз, у скольких людей (сумма по дням), первый и
   *  последний день. */
  async crashPlaces(fromDay: string): Promise<{ version: string; process: string; kind: string; place: string; fingerprint: string; count: number; users: number; first: string; last: string }[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT version, process, kind, place, fingerprint, SUM(count) AS n, SUM(users) AS users, MIN(day_key) AS first, MAX(day_key) AS last
       FROM crash_events WHERE day_key >= ? GROUP BY version, process, kind, place, fingerprint ORDER BY SUM(count) DESC LIMIT 1000`, fromDay,
    );
    return rows.map((r) => ({
      version: String(r.version), process: String(r.process), kind: String(r.kind), place: String(r.place), fingerprint: String(r.fingerprint),
      count: Number(r.n), users: Number(r.users), first: String(r.first), last: String(r.last),
    }));
  }
  // ——— Счётчики фич (этап 3 админки, feature-events.ts): пачка из памяти — одной транзакцией.
  /** Прибавить счёт к строкам человек × день × клиент × фича. */
  async addFeatureCounts(rows: { user_id: number; day_key: string; client: string; feature: string; count: number }[]) {
    if (!rows.length) return;
    await this.transaction(async () => {
      for (const r of rows) {
        await this.run(
          `INSERT INTO feature_events (user_id, day_key, client, feature, count) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id, day_key, client, feature) DO UPDATE SET count = feature_events.count + excluded.count`,
          r.user_id, r.day_key, r.client.slice(0, 20), r.feature.slice(0, 60), r.count,
        );
      }
    });
  }
  /** Счётчики фич с fromDay: по фиче, клиенту, человеку и дню (недели и «людей» считает admin-stats.ts). */
  async adminFeatureRows(fromDay: string): Promise<{ feature: string; client: string; user_id: number; day: string; count: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT feature, client, user_id, day_key AS day, count FROM feature_events WHERE day_key >= ?", fromDay,
    );
    return rows.map((r) => ({ feature: String(r.feature), client: String(r.client), user_id: Number(r.user_id), day: String(r.day), count: Number(r.count) }));
  }
  /** Первый и последний день счётчика фичи по клиентам — за всё хранимое время (последний раз и «данные с»). */
  async adminFeatureLast(): Promise<{ feature: string; client: string; first: string; last: string }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT feature, client, MIN(day_key) AS first, MAX(day_key) AS last FROM feature_events GROUP BY feature, client",
    );
    return rows.map((r) => ({ feature: String(r.feature), client: String(r.client), first: String(r.first), last: String(r.last) }));
  }
  // ——— Аналитика, этап 1 (admin-analytics.ts): выборки с границами времени, только счётчики и номера аккаунтов (без текстов,
  // имён, chat id). «Активный» — одно определение на все отчёты: сообщение с ИИ или без (отметка кнопкой, push, правка мышью;
  // без импорта и поправок к ответам) или минута присутствия с любого клиента.
  /** Кто в какие дни (по поясу человека) был активен с fromDay по toDay включительно: сообщения (как adminActiveDays) ∪ присутствие. */
  async analyticsActiveDays(fromDay: string, toDay: string): Promise<{ day: string; user_id: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT m.day_key AS day, m.user_id FROM messages m
         WHERE m.day_key >= ? AND m.day_key <= ? AND m.source <> 'import' AND (${ADMIN_AI_SQL} OR ${ADMIN_MANUAL_SQL})
       UNION
       SELECT day_key AS day, user_id FROM presence WHERE day_key >= ? AND day_key <= ? AND minutes > 0`,
      fromDay, toDay, fromDay, toDay,
    );
    return rows.map((r) => ({ day: String(r.day), user_id: Number(r.user_id) }));
  }
  /** Для шага «час» за [fromIso, toIso): сообщения по часу UTC (hour — «ГГГГ-ММ-ДДTЧЧ») и присутствие за дни на сутки шире
   *  (местные день и час — в UTC переводит admin-analytics.ts по поясу человека). */
  async analyticsActiveHours(fromIso: string, toIso: string): Promise<{ messages: { hour: string; user_id: number }[]; presence: { user_id: number; day: string; hour: number }[] }> {
    const msgs = await this.all<Record<string, unknown>>(
      `SELECT DISTINCT substr(m.received_at, 1, 13) AS hr, m.user_id FROM messages m
       WHERE m.received_at >= ? AND m.received_at < ? AND m.source <> 'import' AND (${ADMIN_AI_SQL} OR ${ADMIN_MANUAL_SQL})`,
      fromIso, toIso,
    );
    const day = (iso: string, d: number) => new Date(Date.parse(iso.slice(0, 10) + "T00:00:00Z") + d * 86_400_000).toISOString().slice(0, 10);
    const pres = await this.all<Record<string, unknown>>(
      "SELECT user_id, day_key AS day, hour FROM presence WHERE day_key >= ? AND day_key <= ? AND minutes > 0",
      day(fromIso, -1), day(toIso, 1),
    );
    return {
      messages: msgs.map((r) => ({ hour: String(r.hr), user_id: Number(r.user_id) })),
      presence: pres.map((r) => ({ user_id: Number(r.user_id), day: String(r.day), hour: Number(r.hour) })),
    };
  }
  /** Начало данных каждого источника аналитики (ISO или день; пустая таблица — null). gate — счётчики gate.*. Журнал подписки и
   *  отказы ИИ пишутся только по событию, поэтому у них начало — раньшее из первой записи и kv analytics_collect_since (когда
   *  база прошла шаг 28): пустой журнал после этого — честный ноль, а не «нет данных». */
  async analyticsSince(): Promise<{ payments: string | null; billing_events: string | null; feature_events: string | null; gate: string | null; llm_calls: string | null; presence: string | null }> {
    const r = await this.get<Record<string, unknown>>(
      `SELECT (SELECT MIN(paid_at) FROM payments) AS payments, (SELECT MIN(at) FROM billing_events) AS billing_events,
         (SELECT MIN(day_key) FROM feature_events) AS feature_events, (SELECT MIN(day_key) FROM feature_events WHERE feature LIKE 'gate.%') AS gate,
         (SELECT MIN(at) FROM llm_calls) AS llm_calls, (SELECT MIN(day_key) FROM presence) AS presence`,
    );
    const s = (v: unknown) => (v == null ? null : String(v));
    const mark = (await this.kvGet(COLLECT_SINCE_KEY)) ?? null;
    const early = (v: string | null) => (v == null ? mark : mark == null ? v : v.slice(0, 10) <= mark.slice(0, 10) ? v : mark);
    return { payments: s(r?.payments), billing_events: early(s(r?.billing_events)), feature_events: s(r?.feature_events), gate: early(s(r?.gate)), llm_calls: s(r?.llm_calls), presence: s(r?.presence) };
  }
  /** Люди для аналитики: пояс, когда пришли, план и срок. owner — chat id среди owners (сам chat id наружу не идёт). */
  async analyticsUsers(owners: string[]): Promise<{ id: number; tz: string; created_at: string; plan: string; access_until: string | null; sub_canceled: number; trial_len_days: number | null; owner: boolean }[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT id, tz, created_at, plan, access_until, sub_canceled, trial_len_days, chat_id FROM users ORDER BY id");
    return rows.map((r) => ({
      id: Number(r.id), tz: String(r.tz ?? ""), created_at: String(r.created_at ?? ""), plan: String(r.plan ?? ""),
      access_until: r.access_until == null ? null : String(r.access_until), sub_canceled: Number(r.sub_canceled ?? 0) || 0,
      trial_len_days: r.trial_len_days == null ? null : Number(r.trial_len_days),
      owner: r.chat_id != null && owners.includes(String(r.chat_id)),
    }));
  }
  /** Оплаты звёздами (XTR) с paid_at раньше beforeIso: человек, сумма, вид, сроки, возврат. Без payload, charge_id и Telegram id. */
  async analyticsPayments(beforeIso: string): Promise<{ user_id: number; amount: number; kind: string; paid_at: string; expires_at: string | null; refunded_at: string | null }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT user_id, amount, kind, paid_at, expires_at, refunded_at FROM payments WHERE paid_at < ? AND currency = 'XTR' ORDER BY paid_at", beforeIso,
    );
    return rows.map((r) => ({
      user_id: Number(r.user_id), amount: Number(r.amount) || 0, kind: String(r.kind), paid_at: String(r.paid_at),
      expires_at: r.expires_at == null ? null : String(r.expires_at), refunded_at: r.refunded_at == null ? null : String(r.refunded_at),
    }));
  }
  /** Расход модели с fromDay по toDay (дни UTC, включительно): строки день × человек × назначение × модель, деньги — micro$. */
  async analyticsUsage(fromDay: string, toDay: string): Promise<{ day: string; user_id: number; kind: string; model: string; calls: number; priced: number; micro: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT day, user_id, kind, model, calls, priced, micro_usd FROM llm_usage WHERE day >= ? AND day <= ?", fromDay, toDay,
    );
    return rows.map((r) => ({
      day: String(r.day), user_id: Number(r.user_id), kind: String(r.kind), model: String(r.model),
      calls: Number(r.calls) || 0, priced: Number(r.priced) || 0, micro: Number(r.micro_usd) || 0,
    }));
  }
  /** Попытки модели за [fromIso, toIso) из журнала llm_calls (хранится 30 дней): время, человек, назначение, модель, мс, micro$, удачна ли. */
  async analyticsCalls(fromIso: string, toIso: string): Promise<{ at: string; user_id: number; kind: string; model: string; ms: number; micro: number; ok: boolean }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT at, user_id, kind, model, ms, micro_usd, error_code FROM llm_calls WHERE at >= ? AND at < ?", fromIso, toIso,
    );
    return rows.map((r) => ({
      at: String(r.at), user_id: Number(r.user_id), kind: String(r.kind), model: String(r.model), ms: Number(r.ms) || 0,
      micro: Number(r.micro_usd) || 0, ok: String(r.error_code ?? "") === "",
    }));
  }
  /** Сообщения за дни (по поясу человека, включительно) или за [fromIso, toIso) — сводно по дню × часу UTC × человеку × источнику:
   *  с ИИ (ADMIN_AI_SQL), без ИИ (ADMIN_MANUAL_SQL), из них с ИИ и с отменой, поправки к ответам. Импорт не в счёт. */
  async analyticsMessages(r: AnalyticsRange): Promise<{ day: string; hour: string; user_id: number; source: string; ai: number; manual: number; undone: number; corrections: number }[]> {
    const [where, from, to] = rangeSql(r);
    const rows = await this.all<Record<string, unknown>>(
      `SELECT m.day_key AS day, substr(m.received_at, 1, 13) AS hr, m.user_id, m.source,
         SUM(CASE WHEN ${ADMIN_AI_SQL} THEN 1 ELSE 0 END) AS ai,
         SUM(CASE WHEN ${ADMIN_MANUAL_SQL} THEN 1 ELSE 0 END) AS manual,
         SUM(CASE WHEN ${ADMIN_AI_SQL} AND EXISTS (SELECT 1 FROM actions a WHERE a.message_id = m.id AND a.undone = 1) THEN 1 ELSE 0 END) AS undone,
         SUM(CASE WHEN m.source_id LIKE 'correct:%' THEN 1 ELSE 0 END) AS corrections
       FROM messages m WHERE ${where} AND m.source <> 'import'
       GROUP BY m.day_key, substr(m.received_at, 1, 13), m.user_id, m.source`, from, to,
    );
    const n = (v: unknown) => Number(v ?? 0) || 0;
    return rows.map((x) => ({ day: String(x.day), hour: String(x.hr), user_id: Number(x.user_id), source: String(x.source), ai: n(x.ai), manual: n(x.manual), undone: n(x.undone), corrections: n(x.corrections) }));
  }
  /** Виды записей у сообщений с ИИ (по actions.tbl, разные сообщения × вид): tasks, plans, diary, habits, money, other; без действий — talk. */
  async analyticsParseKinds(r: AnalyticsRange): Promise<{ day: string; hour: string; kind: string; n: number }[]> {
    const [where, from, to] = rangeSql(r);
    const kind = `CASE WHEN a.tbl IS NULL THEN 'talk' WHEN a.tbl = 'tasks' THEN 'tasks' WHEN a.tbl = 'events' THEN 'plans' WHEN a.tbl = 'diary' THEN 'diary'
      WHEN a.tbl IN ('habits', 'habit_marks') THEN 'habits' WHEN a.tbl = 'money' THEN 'money' ELSE 'other' END`;
    const rows = await this.all<Record<string, unknown>>(
      `SELECT m.day_key AS day, substr(m.received_at, 1, 13) AS hr, ${kind} AS pkind, COUNT(DISTINCT m.id) AS n
       FROM messages m LEFT JOIN actions a ON a.message_id = m.id
       WHERE ${where} AND ${ADMIN_AI_SQL}
       GROUP BY m.day_key, substr(m.received_at, 1, 13), ${kind}`, from, to,
    );
    return rows.map((x) => ({ day: String(x.day), hour: String(x.hr), kind: String(x.pkind), n: Number(x.n) || 0 }));
  }
  /** Счётчики фич features с fromDay по toDay включительно (день — по поясу человека), сведённые в SQL по фиче × клиенту × дню:
   *  сколько раз. Людей здесь нет — их даёт analyticsFeatureUsers (за год сырых строк в JS не тянем: выборка синхронная). */
  async analyticsFeatureSums(fromDay: string, toDay: string, features: string[]): Promise<{ feature: string; client: string; day: string; uses: number }[]> {
    if (!features.length) return [];
    const rows = await this.all<Record<string, unknown>>(
      `SELECT feature, client, day_key AS day, SUM(count) AS uses FROM feature_events
       WHERE day_key >= ? AND day_key <= ? AND feature IN (${features.map(() => "?").join(", ")}) GROUP BY feature, client, day_key`,
      fromDay, toDay, ...features,
    );
    return rows.map((r) => ({ feature: String(r.feature), client: String(r.client), day: String(r.day), uses: Number(r.uses) || 0 }));
  }
  /** Кто трогал какие фичи features с fromDay по toDay включительно: различные пары фича × человек с count > 0. */
  async analyticsFeatureUsers(fromDay: string, toDay: string, features: string[]): Promise<{ feature: string; user_id: number }[]> {
    if (!features.length) return [];
    const rows = await this.all<Record<string, unknown>>(
      `SELECT feature, user_id FROM feature_events
       WHERE day_key >= ? AND day_key <= ? AND count > 0 AND feature IN (${features.map(() => "?").join(", ")}) GROUP BY feature, user_id`,
      fromDay, toDay, ...features,
    );
    return rows.map((r) => ({ feature: String(r.feature), user_id: Number(r.user_id) }));
  }
  // ——— Оповещения владельцу (шаг 34, alerts.ts): правила, их состояние и журнал срабатываний — только числа.
  async alertRules(): Promise<AlertRuleRow[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT * FROM alert_rules ORDER BY id");
    return rows.map((r) => ({
      id: String(r.id), enabled: Number(r.enabled) ? 1 : 0, threshold: Number(r.threshold), window_min: Number(r.window_min), every_min: Number(r.every_min),
      firing: Number(r.firing ?? 0), last_sent: r.last_sent == null ? null : String(r.last_sent), last_value: r.last_value == null ? null : Number(r.last_value),
      mark: r.mark == null ? null : String(r.mark), updated_at: String(r.updated_at ?? ""), updated_by: Number(r.updated_by ?? 0),
    }));
  }
  /** Дописать недостающие правила (значения по умолчанию); существующие не трогает. */
  async seedAlertRules(rows: Pick<AlertRuleRow, "id" | "enabled" | "threshold" | "window_min" | "every_min" | "mark">[], at = new Date()) {
    for (const r of rows) {
      await this.run(
        "INSERT INTO alert_rules (id, enabled, threshold, window_min, every_min, mark, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
        r.id, r.enabled, r.threshold, r.window_min, r.every_min, r.mark, at.toISOString(),
      );
    }
  }
  /** Поменять поля правила (только перечисленные колонки). */
  async updateAlertRule(id: string, patch: Partial<Omit<AlertRuleRow, "id">>) {
    const cols = (["enabled", "threshold", "window_min", "every_min", "firing", "last_sent", "last_value", "mark", "updated_at", "updated_by"] as const).filter((k) => k in patch);
    if (!cols.length) return;
    await this.run(`UPDATE alert_rules SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, ...cols.map((c) => patch[c] ?? null), id);
  }
  // ——— Нагрузка сервера (шаг 37, server-metrics.ts): снимок раз в минуту, чтение за период, чистка старше 7 дней.
  /** Записать снимок; минута уже есть (перезапуск в ту же минуту) — первый остаётся. */
  async addServerMetric(r: ServerMetricRow) {
    const val = (k: (typeof SERVER_METRIC_COLS)[number]) => {
      if (k === "at") return r.at;
      const v = r[k] as number | null;
      if (v == null || !Number.isFinite(v)) return METRIC_NULLABLE.has(k) ? null : 0;
      return /^(cores|http|http_5xx|bot|llm|llm_err|active|queue|queue_peak|uptime)$/.test(k) ? Math.round(v) : v;
    };
    await this.run(
      `INSERT INTO server_metrics (${SERVER_METRIC_COLS.join(", ")}) VALUES (${SERVER_METRIC_COLS.map(() => "?").join(", ")}) ON CONFLICT (at) DO NOTHING`,
      ...SERVER_METRIC_COLS.map(val),
    );
  }
  /** Снимки с since (ISO, включительно) по порядку времени; cols — только эти столбцы (по умолчанию все). */
  async serverMetrics<K extends ServerMetricCol = ServerMetricCol>(since: string, cols?: readonly K[]): Promise<Pick<ServerMetricRow, K>[]> {
    const sel = (cols ?? SERVER_METRIC_COLS).filter((k) => (SERVER_METRIC_COLS as readonly string[]).includes(k));
    const rows = await this.all<Record<string, unknown>>(`SELECT ${sel.join(", ")} FROM server_metrics WHERE at >= ? ORDER BY at`, since);
    return rows.map((x) => Object.fromEntries(sel.map((k) => [k, k === "at" ? String(x.at) : x[k] == null ? null : Number(x[k])])) as unknown as Pick<ServerMetricRow, K>);
  }
  /** «Счёт OpenRouter» (шаг 38): строки дней from..to (ГГГГ-ММ-ДД, включительно) заменяются rows — повторная загрузка того же
   *  дня не складывается; одной транзакцией, чтобы ручка не увидела окно пустым. */
  async replaceOpenRouterBill(from: string, to: string, rows: OpenRouterBillRow[]) {
    await this.driver.tx(async () => {
      await this.run("DELETE FROM openrouter_bill WHERE day >= ? AND day <= ?", from, to);
      for (const r of rows) {
        if (r.day < from || r.day > to) continue;
        await this.run(
          `INSERT INTO openrouter_bill (${OPENROUTER_BILL_COLS.join(", ")}) VALUES (${OPENROUTER_BILL_COLS.map(() => "?").join(", ")})
           ON CONFLICT (day, model, provider) DO UPDATE SET micro_usd = excluded.micro_usd, byok_micro = excluded.byok_micro, requests = excluded.requests,
           prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens, reasoning_tokens = excluded.reasoning_tokens,
           cached_tokens = excluded.cached_tokens`,
          ...OPENROUTER_BILL_COLS.map((k) => r[k]),
        );
      }
    });
  }
  /** Строки «Счёта OpenRouter» за дни from..to (включительно), по дням и моделям. */
  async openRouterBill(from: string, to: string): Promise<OpenRouterBillRow[]> {
    const rows = await this.all<Record<string, unknown>>(
      `SELECT ${OPENROUTER_BILL_COLS.join(", ")} FROM openrouter_bill WHERE day >= ? AND day <= ? ORDER BY day, model, provider`, from, to,
    );
    return rows.map((x) => ({
      day: String(x.day), model: String(x.model), provider: String(x.provider), micro_usd: Number(x.micro_usd) || 0, byok_micro: Number(x.byok_micro) || 0,
      requests: Number(x.requests) || 0, prompt_tokens: Number(x.prompt_tokens) || 0, completion_tokens: Number(x.completion_tokens) || 0,
      reasoning_tokens: Number(x.reasoning_tokens) || 0, cached_tokens: Number(x.cached_tokens) || 0,
    }));
  }
  /** Наш расход по дням UTC (llm_usage.day — день UTC, addUsage): сумма micro_usd и вызовы без цены — для сверки со счётом OpenRouter. */
  async usageByDay(from: string, to: string): Promise<{ day: string; micro: number; calls: number; unpriced: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT day, SUM(micro_usd) AS micro, SUM(calls) AS calls, SUM(calls - priced) AS unpriced FROM llm_usage WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day",
      from, to,
    );
    return rows.map((x) => ({ day: String(x.day), micro: Number(x.micro) || 0, calls: Number(x.calls) || 0, unpriced: Number(x.unpriced) || 0 }));
  }
  /** Удалить снимки старше before (ISO); вернуть, сколько удалено. */
  async pruneServerMetrics(before: string): Promise<number> {
    return this.run("DELETE FROM server_metrics WHERE at < ?", before);
  }
  async addAlertLog(e: { at: Date; rule: string; kind: string; value: number | null; text: string; sent: boolean }) {
    await this.run("INSERT INTO alert_log (at, rule, kind, value, text, sent) VALUES (?, ?, ?, ?, ?, ?)",
      e.at.toISOString(), e.rule, e.kind, e.value != null && Number.isFinite(e.value) ? e.value : null, e.text.slice(0, 600), e.sent ? 1 : 0);
  }
  async alertLog(limit = 100): Promise<{ at: string; rule: string; kind: string; value: number | null; text: string; sent: boolean }[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT at, rule, kind, value, text, sent FROM alert_log ORDER BY id DESC LIMIT ?", limit);
    return rows.map((r) => ({ at: String(r.at), rule: String(r.rule), kind: String(r.kind), value: r.value == null ? null : Number(r.value), text: String(r.text ?? ""), sent: Boolean(Number(r.sent)) }));
  }
  /** Попытки модели с since: всего и с ошибкой (правило «доля ошибок ИИ»). */
  async alertLlmCalls(since: string): Promise<{ calls: number; errors: number }> {
    const r = await this.get<Record<string, unknown>>("SELECT COUNT(*) AS calls, SUM(CASE WHEN error_code <> '' THEN 1 ELSE 0 END) AS errors FROM llm_calls WHERE at >= ?", since);
    return { calls: Number(r?.calls ?? 0), errors: Number(r?.errors ?? 0) };
  }
  /** События журнала подписки этих видов позже since: сколько и сумма звёзд (правила «возврат», «оплата»). */
  async billingEventsSince(kinds: readonly BillingKind[], since: string): Promise<{ n: number; stars: number }> {
    const r = await this.get<Record<string, unknown>>(
      `SELECT COUNT(*) AS n, SUM(COALESCE(amount, 0)) AS stars FROM billing_events WHERE at > ? AND kind IN (${kinds.map(() => "?").join(", ")})`, since, ...kinds,
    );
    return { n: Number(r?.n ?? 0), stars: Number(r?.stars ?? 0) };
  }
  // ——— Копии базы (шаг 34, snapshot.ts): ночные копии (kind copy) и проверки восстановления (kind verify).
  async addDbCopy(e: Omit<DbCopyRow, "id">): Promise<void> {
    await this.run(
      "INSERT INTO db_copies (at, kind, status, file, bytes, gz_bytes, sent, problem, note, by_user, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      e.at, e.kind, e.status, e.file, e.bytes, e.gz_bytes, e.sent, e.problem.slice(0, 300), e.note.slice(0, 300), e.by_user, e.ms,
    );
  }
  async dbCopies(kind: "copy" | "verify", limit = 20): Promise<DbCopyRow[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT * FROM db_copies WHERE kind = ? ORDER BY at DESC, id DESC LIMIT ?", kind, limit);
    return rows.map((r) => ({
      id: Number(r.id), at: String(r.at), kind: String(r.kind) as DbCopyRow["kind"], status: String(r.status) as DbCopyRow["status"], file: String(r.file ?? ""),
      bytes: Number(r.bytes ?? 0), gz_bytes: Number(r.gz_bytes ?? 0), sent: Number(r.sent ?? 0), problem: String(r.problem ?? ""), note: String(r.note ?? ""),
      by_user: Number(r.by_user ?? 0), ms: Number(r.ms ?? 0),
    }));
  }
  /** Сколько строк в главных таблицах — сверка копии с живой базой (проверка восстановления). */
  async rowCounts(): Promise<{ users: number; messages: number }> {
    const n = async (t: "users" | "messages") => Number((await this.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${t}`))?.n ?? 0);
    return { users: await n("users"), messages: await n("messages") };
  }
  /** Команда без разбора результата (снимок базы: VACUUM INTO). */
  async raw(sql: string, ...args: unknown[]): Promise<void> {
    await this.driver.run(sql, args);
  }
  async once(key: string): Promise<boolean> {
    return (await this.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", key, now())) > 0;
  }

  // --- этап 6 «Тарифы и управление» (шаг 36): переключатели, промокоды, обращения, объявления, прогноз ---

  /** Строки переключателей функций (switches.ts): нет строки — функция включена. */
  async featureSwitches(): Promise<SwitchRow[]> {
    const rows = await this.all<Record<string, unknown>>("SELECT id, enabled, updated_at, updated_by FROM feature_switches ORDER BY id");
    return rows.map((r) => ({ id: String(r.id), enabled: Number(r.enabled), updated_at: String(r.updated_at), updated_by: Number(r.updated_by ?? 0) }));
  }
  async setFeatureSwitch(id: string, enabled: boolean, at: Date, by: number) {
    await this.run(
      `INSERT INTO feature_switches (id, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      id, enabled ? 1 : 0, at.toISOString(), by,
    );
  }

  /** Промокоды (promo.ts), новые сверху. */
  async promoCodes(limit = 200): Promise<PromoRow[]> {
    return (await this.all<Record<string, unknown>>("SELECT * FROM promo_codes ORDER BY id DESC LIMIT ?", limit)).map(toPromo);
  }
  async promoByCode(code: string): Promise<PromoRow | undefined> {
    const r = await this.get<Record<string, unknown>>("SELECT * FROM promo_codes WHERE code = ?", code);
    return r ? toPromo(r) : undefined;
  }
  async promoById(id: number): Promise<PromoRow | undefined> {
    const r = await this.get<Record<string, unknown>>("SELECT * FROM promo_codes WHERE id = ?", id);
    return r ? toPromo(r) : undefined;
  }
  /** Новый код; такой уже есть — null (UNIQUE). */
  async addPromoCode(p: { code: string; days: number; max_uses: number; ends_at: string | null; at: Date; by: number }): Promise<number | null> {
    const n = await this.run(
      "INSERT INTO promo_codes (code, days, max_uses, ends_at, enabled, created_at, created_by) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT (code) DO NOTHING",
      p.code, p.days, p.max_uses, p.ends_at, p.at.toISOString(), p.by,
    );
    return n ? ((await this.promoByCode(p.code))?.id ?? null) : null;
  }
  async setPromoEnabled(id: number, enabled: boolean): Promise<number> {
    return this.run("UPDATE promo_codes SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id);
  }
  /** Какой код применил человек (один на человека) или undefined. */
  async promoUseOf(userId: number): Promise<{ code_id: number; days: number; at: string } | undefined> {
    const r = await this.get<Record<string, unknown>>("SELECT code_id, days, at FROM promo_uses WHERE user_id = ?", userId);
    return r ? { code_id: Number(r.code_id), days: Number(r.days), at: String(r.at) } : undefined;
  }
  /** Занять применение кода: сначала строка «человек применил» (второй раз — mine), потом счётчик кода, если код ещё действует
   *  (выключен, кончился или исчерпан — gone, строка человека убирается). Две атомарные команды: два одновременных запроса одного
   *  человека не применят два кода, а последнее применение не уйдёт двоим. */
  async takePromo(userId: number, codeId: number, days: number, at: Date): Promise<"ok" | "mine" | "gone"> {
    const mine = await this.run("INSERT INTO promo_uses (user_id, code_id, days, at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING", userId, codeId, days, at.toISOString());
    if (!mine) return "mine";
    const took = await this.run(
      "UPDATE promo_codes SET used = used + 1 WHERE id = ? AND enabled = 1 AND used < max_uses AND (ends_at IS NULL OR ends_at > ?)", codeId, at.toISOString(),
    );
    if (took) return "ok";
    await this.dropPromoUse(userId, codeId);
    return "gone";
  }
  /** Вернуть применение (дни добавить не вышло): строка человека и счётчик кода. */
  async dropPromoUse(userId: number, codeId: number, uncount = false) {
    await this.run("DELETE FROM promo_uses WHERE user_id = ? AND code_id = ?", userId, codeId);
    if (uncount) await this.run("UPDATE promo_codes SET used = used - 1 WHERE id = ? AND used > 0", codeId);
  }

  /** Обращение человека (support.ts). */
  addTicket(t: { user_id: number; topic: string; text: string; at: Date }): Promise<number> {
    const at = t.at.toISOString();
    return this.insert("INSERT INTO support_tickets (user_id, topic, text, status, created_at, updated_at) VALUES (?, ?, ?, 'new', ?, ?)", t.user_id, t.topic, t.text, at, at);
  }
  /** Сколько обращений человек написал с since (ISO) — частота. */
  async ticketsOfSince(userId: number, since: string): Promise<number> {
    return Number((await this.get<{ n: unknown }>("SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND created_at >= ?", userId, since))?.n ?? 0);
  }
  /** Новых обращений с since (ISO) — правило оповещений support_new. */
  async ticketsSince(since: string): Promise<number> {
    return Number((await this.get<{ n: unknown }>("SELECT COUNT(*) AS n FROM support_tickets WHERE created_at >= ?", since))?.n ?? 0);
  }
  /** Список для админки — без текста и ответа (их видно только в карточке обращения). */
  async ticketList(limit = 200): Promise<Omit<TicketRow, "text" | "answer">[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT id, user_id, topic, status, created_at, updated_at, answered_at FROM support_tickets ORDER BY id DESC LIMIT ?", limit,
    );
    return rows.map((r) => ({
      id: Number(r.id), user_id: Number(r.user_id), topic: String(r.topic), status: String(r.status) as TicketStatus,
      created_at: String(r.created_at), updated_at: String(r.updated_at), answered_at: r.answered_at == null ? null : String(r.answered_at),
    }));
  }
  async ticket(id: number): Promise<TicketRow | undefined> {
    const r = await this.get<Record<string, unknown>>("SELECT * FROM support_tickets WHERE id = ?", id);
    return r ? {
      id: Number(r.id), user_id: Number(r.user_id), topic: String(r.topic), text: String(r.text), status: String(r.status) as TicketStatus,
      created_at: String(r.created_at), updated_at: String(r.updated_at), answer: String(r.answer ?? ""), answered_at: r.answered_at == null ? null : String(r.answered_at),
    } : undefined;
  }
  /** Обращения одного человека, новые сверху (его «Написать нам»): тема, статус, есть ли ответ — его же тексты ему видны. */
  async ticketsOf(userId: number, limit = 10): Promise<TicketRow[]> {
    const ids = await this.all<{ id: number }>("SELECT id FROM support_tickets WHERE user_id = ? ORDER BY id DESC LIMIT ?", userId, limit);
    const out: TicketRow[] = [];
    for (const r of ids) { const t = await this.ticket(Number(r.id)); if (t) out.push(t); }
    return out;
  }
  async updateTicket(id: number, p: { status?: TicketStatus; answer?: string; answered_at?: string; at: Date }) {
    if (p.status) await this.run("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?", p.status, p.at.toISOString(), id);
    if (p.answer !== undefined) await this.run("UPDATE support_tickets SET answer = ?, answered_at = ?, updated_at = ? WHERE id = ?", p.answer, p.answered_at ?? p.at.toISOString(), p.at.toISOString(), id);
  }

  /** Объявления (announce.ts), новые сверху. */
  async announcements(limit = 100): Promise<AnnouncementRow[]> {
    return (await this.all<Record<string, unknown>>("SELECT * FROM announcements ORDER BY id DESC LIMIT ?", limit)).map(toAnnouncement);
  }
  async announcement(id: number): Promise<AnnouncementRow | undefined> {
    const r = await this.get<Record<string, unknown>>("SELECT * FROM announcements WHERE id = ?", id);
    return r ? toAnnouncement(r) : undefined;
  }
  addAnnouncement(a: { text: string; audience: string; site: boolean; widget: boolean; ends_at: string | null; at: Date; by: number }): Promise<number> {
    const at = a.at.toISOString();
    return this.insert(
      "INSERT INTO announcements (text, audience, site, widget, enabled, ends_at, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
      a.text, a.audience, a.site ? 1 : 0, a.widget ? 1 : 0, a.ends_at, at, a.by, at,
    );
  }
  async setAnnouncementEnabled(id: number, enabled: boolean, at: Date): Promise<number> {
    return this.run("UPDATE announcements SET enabled = ?, updated_at = ? WHERE id = ?", enabled ? 1 : 0, at.toISOString(), id);
  }
  /** Каким объявлениям человек уже получил строку в ленте виджета. */
  async announcementsSeen(userId: number): Promise<number[]> {
    return (await this.all<{ announcement_id: number }>("SELECT announcement_id FROM announcement_seen WHERE user_id = ?", userId)).map((r) => Number(r.announcement_id));
  }
  /** Отметить «ушло в ленту»; уже было — false (два одновременных опроса не запишут два письма). */
  async markAnnouncementSeen(id: number, userId: number, at: Date): Promise<boolean> {
    return (await this.run("INSERT INTO announcement_seen (announcement_id, user_id, at) VALUES (?, ?, ?) ON CONFLICT (announcement_id, user_id) DO NOTHING", id, userId, at.toISOString())) > 0;
  }
  /** Сколько людей объявление уже получило в виджете. */
  async announcementReach(): Promise<Map<number, number>> {
    const rows = await this.all<Record<string, unknown>>("SELECT announcement_id AS id, COUNT(*) AS n FROM announcement_seen GROUP BY announcement_id");
    return new Map(rows.map((r) => [Number(r.id), Number(r.n)]));
  }

  /** Звёзды по дням (UTC, первые 10 знаков paid_at) с since (ISO), без возвращённых — прогноз доходов. */
  async starDays(since: string): Promise<{ day: string; stars: number; n: number }[]> {
    const rows = await this.all<Record<string, unknown>>(
      "SELECT SUBSTR(paid_at, 1, 10) AS day, SUM(amount) AS stars, COUNT(*) AS n FROM payments WHERE paid_at >= ? AND refunded_at IS NULL AND currency = 'XTR' GROUP BY SUBSTR(paid_at, 1, 10) ORDER BY day",
      since,
    );
    return rows.map((r) => ({ day: String(r.day), stars: Number(r.stars) || 0, n: Number(r.n) || 0 }));
  }
}

export interface SwitchRow { id: string; enabled: number; updated_at: string; updated_by: number }
export interface PromoRow { id: number; code: string; days: number; max_uses: number; used: number; ends_at: string | null; enabled: number; created_at: string; created_by: number }
export type TicketStatus = "new" | "work" | "closed";
export interface TicketRow { id: number; user_id: number; topic: string; text: string; status: TicketStatus; created_at: string; updated_at: string; answer: string; answered_at: string | null }
export interface AnnouncementRow { id: number; text: string; audience: string; site: number; widget: number; enabled: number; ends_at: string | null; created_at: string; created_by: number; updated_at: string }

function toPromo(r: Row): PromoRow {
  return {
    id: Number(r.id), code: String(r.code), days: Number(r.days), max_uses: Number(r.max_uses), used: Number(r.used), ends_at: r.ends_at == null ? null : String(r.ends_at),
    enabled: Number(r.enabled), created_at: String(r.created_at), created_by: Number(r.created_by ?? 0),
  };
}
function toAnnouncement(r: Row): AnnouncementRow {
  return {
    id: Number(r.id), text: String(r.text), audience: String(r.audience), site: Number(r.site), widget: Number(r.widget), enabled: Number(r.enabled),
    ends_at: r.ends_at == null ? null : String(r.ends_at), created_at: String(r.created_at), created_by: Number(r.created_by ?? 0), updated_at: String(r.updated_at),
  };
}

function toActivity(r: Row): ActivityRow {
  return {
    user_id: Number(r.user_id),
    day_key: r.day_key as string,
    source: r.source as string,
    active_sec: Number(r.active_sec),
    afk_sec: Number(r.afk_sec),
    apps: JSON.parse(r.apps_json as string),
    games: JSON.parse(r.games_json as string),
    updated_at: r.updated_at as string,
  };
}
