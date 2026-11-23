---
title: Данные и API
lead: Таблицы базы и адреса сервера — что где лежит и кто это зовёт.
---

## Таблицы

Схема — `server/src/db.ts`, одна для SQLite и Postgres.

| Таблица | Что хранит |
|---|---|
| `users` | пользователь и настройки: характер, время утра/«завтра»/вечера, `event_lead_min` и `event_reminders` (когда напоминать о планах: `day`, минуты через запятую, `off`; пусто — за `event_lead_min` и в момент), игры (`game_alerts`, `game_first_min`, `game_every_min`), внешность Рины (шаг 19, «Перекрасить Рину»): `maid_hair` — волосы `red` (свои, по умолчанию) / `brown` / `gold` / `silver` / `violet` / `black`, `maid_eyes` — глаза `violet` (свои, по умолчанию) / `green` / `blue` / `amber`; id и названия — `server/src/look.ts`, те же, что `LOOK_HAIR` / `LOOK_EYES` в `desktop/renderer/look.js`; выбранные цвета подставляются в карточку Рины во всех промптах (`persona(u.persona, u)` → `rina` в `personas.ts`); «О вас» (шаг 20, `server/src/you.ts`): `address` — обращение `master` («хозяин», по умолчанию) / `mistress` («хозяйка») / `name` (по `name`), `city` — JSON выбранного города `{name, region, country, lat, lon, tz}` или пусто, `wake` — подъём в минутах от полуночи, 04:00–11:59 (с 20.11.2026; число меньше 24 — прежний час, и 7 по умолчанию у новых: читать через `wakeMinOf`), `bed` — отбой `auto` или «ЧЧ:ММ» с 18:00 до 03:59, `ask` — JSON `{set, off, last}`: какие поля человек указал сам (для «Заполнено N из 7» — у подъёма, обращения и пояса есть значения по умолчанию), о чём больше не спрашивать, когда спрашивала; `tz` меняется: город ставит свой пояс, если человек не задавал пояс сам, стёртый город уносит взятый от него пояс; пояс, выбранный самим (`ask.set` содержит `tz`), город не трогает ни при выборе, ни при стирании (`tzFollowsCity`); `weather_rain` — «Предупредить о дожде за час» (0/1, по умолчанию 0; шаг 21) |
| `sessions` | входы на сайт и в программу — только хеш ключа; вход, которым не пользовались 90 дней, закрывается при следующем обращении (`SESSION_IDLE_DAYS`) |
| `messages` | сырые сообщения и ответы на них; `parse_json` — разбор модели, у ответа с вопросом «Сдвинуть?» рядом с ним пара `clash: {eventId, withId}` (по ней `decideClash` узнаёт строку ⚠); у служебного сообщения поправки к ответу — её итог (`changed`, `clarify`, `asked`, `clash`, после ответа кнопкой — `clashDone`) |
| `diary` | записи дневника по разделам |
| `events` | планы, повторы |
| `tasks` | задачи |
| `notes` | заметки «на потом» (шаг 17): полка `shelf`, название, пометка, статус (`open`, `done`, `deleted`, `purged`), оценка `rating` 1–10 у готовой, `closed_at` |
| `dates` | важные даты: `date_iso` (год меньше года записи `created_at` — настоящий, тогда считается возраст, `yearKnown` в `report.ts`; без года — год записи), `type`, `yearly`, статус (`active`, `deleted`, `purged`), `closed_at` — когда удалена (шаг 18, для корзины) |
| `memory` | что помнить |
| `metrics` | числа: вес, сон, шаги… |
| `habits`, `habit_marks` | привычки и отметки по дням; у отметки — сколько сделано (`amount`, `unit`), если человек сам назвал число |
| `money` | деньги |
| `reminders` | запланированные и отправленные напоминания |
| `activity` | трекер ПК |
| `actions` | журнал действий для отмены: `kind` — `add` (записано), `update` / `status` / `mark` (правка словами, отметка), `edit` (правка мышью — под своим служебным сообщением; поправка к ответу — под исходным сообщением); `before_json` — прежние поля, «Отменить» идёт от новых к старым |
| `push_subs` | подписки браузеров |
| `notices` | письма горничной для виджета и сайта: текст, эмоция, кнопки, вид (`kind`, шаг схемы 15); хранится последняя тысяча на человека |
| `app_icons` | иконки программ трекера |
| `llm_usage` | расход по дням (UTC) × назначение × модель: запросов, токенов на вход и на ответ, денег (`micro_usd` — миллионные доллара) и сколько запросов пришли с ценой; старые месяцы до этой таблицы — в `kv` `llm:ГГГГ-ММ` (без денег), прибавляются к итогу месяца |
| `drawings` | картинки, нарисованные по просьбе: описание для модели, подпись, тип и сама картинка (base64) — ссылка RunPod живёт 7 дней |
| `traits` | дебафы и бафы профиля: вид (`debuff`/`buff`), категория, название, заметка, откуда (`user` — сами, `chat` — сказали горничной, `pattern` — она нашла), статус (`active`, `suggested` — ждёт ответа, `declined` — отказались, больше не предлагать, `removed`), дни-доказательства закономерности |
| `kv` | мелкие отметки «уже отправлено» (раз в сутки удаляются старше 60 дней — `pruneOnce`), расход токенов до таблицы `llm_usage` `llm:ГГГГ-ММ` (больше не пишется), профиль `profile:<id>` (класс — старое поле, рост, дата рождения, аватар, ссылка на профиль Steam, откуда взят аватар), попытки повтора разбора `retry:<id>` |

> **Ключи.** Пароли — scrypt, ключи входа в базе только хешем (`auth.ts`). Ключ программы на ПК лежит в её `settings.json`, зашифрованный защитой Windows (`safeStorage`), и в окна не передаётся.

## Резервные копии и восстановление

| Копия | Что в ней | Где |
|---|---|---|
| Снимок базы | вся база целиком: записи, сообщения, журнал отмены, напоминания, настройки | раз в сутки после 00:00 UTC — `snapshots/maid-ГГГГ-ММ-ДД.sqlite` рядом с базой (14 последних) и `latest.sqlite` (`snapshot.ts`; только SQLite) |
| Копия на ПК | тот же снимок вне сервера | `deploy/pull-backup.ps1` забирает `latest.sqlite` по SSH в «Документы\Горничная — копии базы» (30 последних); каждый день — через Планировщик заданий Windows |
| JSON пользователя | только записи одного пользователя | раз в сутки в 03:30 в Telegram, на сайте — «Скачать копию» (`backup.ts`) |

- **Поднять базу из снимка:** скопировать файл на сервер и `bash /srv/maid/deploy/restore.sh <файл.sqlite>` — проверяет снимок (`snapshot.ts check`), останавливает горничную, прежнюю базу оставляет рядом как `maid.sqlite.before-restore-<время>`, ждёт `/healthz`.
- **Проверка руками (раз в несколько месяцев):** взять копию с ПК, на любой машине с Node 22 — `DB_FILE=<копия> npm run server` в папке проекта (без ключа бота и модели), открыть `http://localhost:3000`, войти — записи на месте.

## Адреса

Все `/api/...` — с ключом `Bearer`, кроме входа и публичных.

| Группа | Адреса |
|---|---|
| Служебные | `/healthz`, `/webhook` (Telegram; с 24.11.2026 — только с заголовком `X-Telegram-Bot-Api-Secret-Token`, иначе 401: секрет выводится из токена бота, `webhook.ts`, и передаётся Telegram в `setWebhook` при запуске) |
| Вход | `/api/login`, `/api/logout`, `/api/me` (строка `users` без `password_hash`, в т. ч. `maid_hair`, `maid_eyes`, и `sessions`), `/api/public` |
| Настройки | `/api/settings` (характер — только из `PERSONAS`, иначе 400; `maid_hair`, `maid_eyes` — только id из `look.ts`, иначе 400 «нет такого цвета»; ответ — строка `users` без `password_hash`), `/api/personas`, `/api/backup` |
| Push | `/api/push/key`, `/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/test`, `/api/push/act` |
| День | `/api/today` (день целиком и рядом `persona`, `maid_hair`, `maid_eyes` — по ним виджет ПК перекрашивает анимации на каждом опросе; `upcoming`, `far_fresh`, `gone_fresh`, `done_fresh`, `tasks`, `notes`, `done_today`, `dates`, `xp` — опыт и уровень `{ xp, level, into, need }` для полосы в шапке виджета ПК, та же формула, что в профиле, `profile.ts xpOf`; `call` — слово обращения («хозяин», «хозяйка» или имя), `wake_at` — подъём «06:30», `wake` — его час (для виджетов до 0.1.83), `bed` — отбой из «О вас»; `ask` — вопрос Рины о вас для облачка `{field, text, buttons}` или null (`askNext`); `you_set` — какие из подъёма и отбоя человек выбрал сам (виджет не переносит поверх них прежние настройки ПК); `todayJson`), `/api/day`, `/api/notices` |
| Дневник | `/api/diary`, `/api/diary/days`, `DELETE /api/diary/:id`, `POST /api/sleep` (сон за день вручную или `clear`) |
| Планы | `/api/events`, `POST /api/events` (новый план из виджета: `title`, `date`, `time`, `end_time`; с отменой), `POST /api/events/:id`, `…/repeat`, `…/copy` |
| Задачи и даты | `/api/tasks`, `POST /api/tasks/:id` (`status`, в т. ч. `deleted`; `due_date`; `title`), `POST /api/tasks/:id/plan` (задача → план), `POST /api/tasks/:id/copy` (`date`), `GET /api/dates` (`?all=1` — на год вперёд; у каждой `on`, `inDays`, `age`, `year_known`), `POST /api/dates` (`title`, `month`, `day`, `year` или null, `type`, `yearly`; отменяется — `undo`), `POST /api/dates/:id` (то же по частям, `status`: `deleted` — в корзину, `active` — вернуть); корзина — `dates` в `GET /api/trash` и `POST /api/trash/purge` (проверка — `server/test/dates-edit.test.ts`) |
| Заметки | `GET /api/notes` → `{shelves: [{key, title, rated}], notes}` (ждущие и готовые); `POST /api/notes` (`title`, `shelf`, `note`; такая же на полке уже есть — она же с `duplicate`); `POST /api/notes/:id` (`status`: `open` / `done` / `deleted`, `rating` 1–10, `shelf`, `title`, `note`) — в ответе `undo`, правка откатывается как правка задачи. Удалённые — в `/api/trash` (`notes`), находятся в `/api/search` (`notes`), `POST /api/trash/purge` принимает `notes` |
| Привычки | `/api/habits`, `/api/habits/:id/mark`, `GET /api/habits/:id/stats` (статистика одной привычки: год по дням — 371 клетка с понедельника 52 недели назад, серия сейчас и лучшая, сделано из запланированного за 30, 90 дней и всё время, по дням недели и 12 месяцам; неотмеченное сегодня не считается; `habitStatsOf`), `POST /api/habits/:id` (title, quiet, times — время напоминаний ЧЧ:ММ, до 4, пусто — общее из настроек, finish — конец вчера или сегодня, если отмечена; status stopped — удалить; отметки остаются; через журнал отмены) |
| Числа | `/api/money`, `/api/metrics`, `/api/steps`, `/api/health/topics` |
| О вас | `GET /api/you` (обращение и слово `call`, город, `tz` со смещением `tz_offset` «UTC+5» и `tz_from_city`, `wake` «06:30», `bed`, день рождения и рост из профиля, `filled` — заполненные поля, последний вес и число дебафов/бафов — для показа; `youView`), `POST /api/you` (`address`, `name`, `city` — город из `/api/city` или null, `tz`, `wake` («06:30» или час числом), `bed` («23:45» или `auto`) — null у них «стереть», снова по умолчанию, `birthday`, `height`; неверное — 400; сменился пояс — напоминания о планах перекладываются; `saveYou`), `GET /api/city?q=` — до 6 городов геокодера Open-Meteo по-русски, от 2 букв, сеть не ответила — 502 (`findCities`); `POST /api/you/ask` (`field`) — виджет показал вопрос Рины, следующий не раньше чем через 3 дня (`askShown`); `POST /api/you/button` (`data` — кнопка `you:…`: ответ на вопрос облачка или «Записать в профиль?») → `{text}`, чужая кнопка — 400 (`youButton`; те же кнопки принимает `/api/push/act` и бот); проверка — `server/test/you.test.ts` |
| Погода | `GET /api/weather` → `{weather}`: null без города или прогноза, иначе `{city, day, kind, danger, icon, temp, sky, parts: [{name, icon, temp, hot}], text, pose, emotion, hit, plan: {id, title, time} \| null, task_id, move, facts}` — прогноз Open-Meteo на сегодня по городу из «О вас» (память на город и день, обновление раз в 3 ч, ожидание 4 с; `weatherFor`); `POST /api/weather/move` (`eventId`, `back`) — план с сегодня на завтра или обратно, не сегодняшний — 404 (`moveToTomorrow`); `weather_rain` — в `POST /api/settings`; проверка — `server/test/weather.test.ts` |
| Профиль | `GET/POST /api/profile` (title, height, birthday — ГГГГ-ММ-ДД или пусто, avatar — data URL; возраст в характеристиках — полных лет по дате рождения), `POST /api/profile/steam` (link — ссылка на профиль Steam: аватар берётся оттуда), `POST /api/traits` (новый дебаф/баф), `POST /api/traits/:id` (status, title, note; у предложенного `active`/`declined` — ответ на предложение) |
| Альбом реакций | `GET /api/album` → `{seen: {имя: когда увидел впервые}, total: 27}`; `POST /api/album {moods: [имена]}` — отметить увиденное (шлёт виджет), в ответе `fresh` — что открылось этим вызовом; чужое имя — 400. Хранится в `kv` `album:<id пользователя>` |
| История писем | `GET /api/history?kinds=morning,plan&before=<id>&limit=50` → `{items: [{id, kind, text, emotion, at}], more}` — от свежих к старым, `kinds` — только этих видов (пусто — все), `before` — старше этого письма, `limit` до 200 |
| Расход | `GET /api/usage?days=7…90` — по дням (все подряд, UTC), по назначениям и моделям, итог месяца (`usageReport`) |
| Картинки | `GET /api/drawings/:id` — нарисованная по просьбе картинка (mime, data base64, title, prompt); только своя |
| Ввод | `/api/input` (текст и/или `images: [{data, mime}]`, до 6; у карточек ответа `changes` — `ref: {tbl, id}`), `/api/voice`, `/api/undo`, `POST /api/correct` (поправка к ответу: `messageId` — id ответа, `text` 1–500, `id` до 80 — повтор с тем же не пишет второй раз; чужой или неизвестный ответ — 404, неверное тело — 400; ответ — `{text, emotion, messageId, undoable, changes, changed, clarify?, clash?, duplicate?}`; `clash` решается `POST /api/clash` с тем же `messageId` — итог встаёт в ответ служебного сообщения поправки, а если ту же пару спрашивал и сам ответ — и в его ответ; глава «Разбор» → «Поправка к ответу»; проверка — `server/test/correct.test.ts`) |
| Трекер | `/api/activity`, `/api/icons` (чтение и запись) |

## Кто что зовёт

| Клиент | Чаще всего |
|---|---|
| Виджет на ПК | `/api/today` и `/api/notices` раз в 5 с, `/api/input`, отметки задач и привычек |
| Трекер ПК | `POST /api/activity` раз в 10 мин, `POST /api/icons` |
| Сайт | всё, по экранам |
| Айфон | `/api/today`, `/api/public` |
| Telegram | `/webhook` |

## Добавить адрес

```flow
Обработчик | в `api.ts`, с проверкой ключа
Данные | запрос в `db.ts`, проверка входа Zod
Изменение | через `logAction`, если его нужно уметь отменять, и `onChange`
Клиент | вызов в `web/src/api.ts` или `maid.api` в виджете
Каталог | строка в таблицу адресов
```
