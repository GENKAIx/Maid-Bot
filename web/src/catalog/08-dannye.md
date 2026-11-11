---
title: Данные и API
lead: Таблицы базы и адреса сервера — что где лежит и кто это зовёт.
---

## Таблицы

Схема — `server/src/db.ts`, одна для SQLite и Postgres.

| Таблица | Что хранит |
|---|---|
| `users` | пользователь и настройки: характер, время утра/«завтра»/вечера, `event_lead_min`, игры (`game_alerts`, `game_first_min`, `game_every_min`) |
| `sessions` | входы на сайт и в программу — только хеш ключа; вход, которым не пользовались 90 дней, закрывается при следующем обращении (`SESSION_IDLE_DAYS`) |
| `messages` | сырые сообщения и ответы на них |
| `diary` | записи дневника по разделам |
| `events` | планы, повторы |
| `tasks` | задачи |
| `dates` | важные даты |
| `memory` | что помнить |
| `metrics` | числа: вес, сон, шаги… |
| `habits`, `habit_marks` | привычки и отметки по дням |
| `money` | деньги |
| `reminders` | запланированные и отправленные напоминания |
| `activity` | трекер ПК |
| `actions` | журнал действий для отмены |
| `push_subs` | подписки браузеров |
| `notices` | уведомления для виджета и сайта |
| `app_icons` | иконки программ трекера |
| `traits` | дебафы и бафы профиля: вид (`debuff`/`buff`), категория, название, заметка, откуда (`user` — сами, `chat` — сказали горничной, `pattern` — она нашла), статус (`active`, `suggested` — ждёт ответа, `declined` — отказались, больше не предлагать, `removed`), дни-доказательства закономерности |
| `kv` | мелкие отметки «уже отправлено» (раз в сутки удаляются старше 60 дней — `pruneOnce`), расход токенов `llm:ГГГГ-ММ`, профиль `profile:<id>` (класс — старое поле, рост, дата рождения, аватар, ссылка на профиль Steam, откуда взят аватар), попытки повтора разбора `retry:<id>` |

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
| Служебные | `/healthz`, `/webhook` (Telegram) |
| Вход | `/api/login`, `/api/logout`, `/api/me`, `/api/public` |
| Настройки | `/api/settings`, `/api/backup` |
| Push | `/api/push/key`, `/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/test`, `/api/push/act` |
| День | `/api/today`, `/api/day`, `/api/notices` |
| Дневник | `/api/diary`, `/api/diary/days`, `DELETE /api/diary/:id` |
| Планы | `/api/events`, `POST /api/events/:id`, `…/repeat`, `…/copy` |
| Задачи и даты | `/api/tasks`, `POST /api/tasks/:id` (`status`, в т. ч. `deleted`; `due_date`; `title`), `POST /api/tasks/:id/plan` (задача → план), `POST /api/tasks/:id/copy` (`date`), `/api/dates` |
| Привычки | `/api/habits`, `/api/habits/:id/mark`, `POST /api/habits/:id` (title, quiet, finish — конец вчера или сегодня, если отмечена; status stopped — удалить; отметки остаются; через журнал отмены) |
| Числа | `/api/money`, `/api/metrics`, `/api/steps`, `/api/health/topics` |
| Профиль | `GET/POST /api/profile` (title, height, birthday — ГГГГ-ММ-ДД или пусто, avatar — data URL; возраст в характеристиках — полных лет по дате рождения), `POST /api/profile/steam` (link — ссылка на профиль Steam: аватар берётся оттуда), `POST /api/traits` (новый дебаф/баф), `POST /api/traits/:id` (status, title, note; у предложенного `active`/`declined` — ответ на предложение) |
| Ввод | `/api/input` (текст и/или `images: [{data, mime}]`, до 6), `/api/voice`, `/api/undo` |
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
