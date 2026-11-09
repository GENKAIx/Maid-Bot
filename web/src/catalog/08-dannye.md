---
title: Данные и API
lead: Таблицы базы и адреса сервера — что где лежит и кто это зовёт.
---

## Таблицы

Схема — `server/src/db.ts`, одна для SQLite и Postgres.

| Таблица | Что хранит |
|---|---|
| `users` | пользователь и настройки: характер, время утра/«завтра»/вечера, `event_lead_min`, игры (`game_alerts`, `game_first_min`, `game_every_min`) |
| `sessions` | входы на сайт и в программу — только хеш ключа |
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
| `kv` | мелкие отметки «уже отправлено» |

> **Ключи.** Пароли — scrypt, ключи входа в базе только хешем (`auth.ts`). Ключ программы на ПК лежит в её `settings.json` и в окна не передаётся.

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
| Задачи и даты | `/api/tasks`, `POST /api/tasks/:id` (`status`, в т. ч. `deleted`; `due_date`), `/api/dates` |
| Привычки | `/api/habits`, `/api/habits/:id/mark` |
| Числа | `/api/money`, `/api/metrics`, `/api/steps`, `/api/health/topics` |
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
