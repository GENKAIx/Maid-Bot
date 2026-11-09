# Горничная 2.0 — правила проекта

- Общайся с пользователем по-русски, кратко.
- Архитектура, решения и этапы — `docs/АРХИТЕКТУРА.md`; менять вместе с кодом.
- Каталог для разработки (вся логика, механики, события, таймеры, реакции горничной) — `web/src/catalog/NN-имя.md`, на сайте
  «Ещё → Каталог» (`/catalog`). Меняется поведение — в том же коммите правится его глава (таблицы, числа, имена функций).
- Старый бот `C:\Users\fazek\Desktop\CodexProject` (Render, Apps Script, Google Таблица) **не трогать** — он работает.
  Материалы прошлого: Obsidian `C:\Users\fazek\Desktop\Obsidian TG\Genkai OBSIDIAN\Telegram tab bot\` (только чтение).
- Хранилище — `server/src/db.ts` (все методы асинхронные): SQLite у себя (`DB_FILE`) или Postgres на Render (`DATABASE_URL`).
  SQL пишется один раз, `driver.ts` переводит его под базу. Новый метод — тест на обеих (`test/data.test.ts`, Postgres — PGlite).
  Google Таблицы больше нет.
- Веб-приложение — `web/` (React + Vite + TS, своя стилизация, без UI-библиотек); `npm run build` → `web/dist`, сервер отдаёт
  его с корня (`WEB_DIR`). Новый экран — свой файл в `web/src/screens`, данные — только через `/api/...`; новая ручка API — тест.
  Перед коммитом: `npm --workspace web run typecheck` и `npm run build`.
- Уведомления идут через один `Send` (Telegram + Web Push, `server/src/push.ts`); кнопки в push — подписанный список,
  обработка в `api.ts` `runButton` — та же, что callback бота. Облако — Render (`render.yaml`, `docs/RENDER.md`).
- Секреты только в `.env` и `secrets/` (в git не идут). Не писать их в документы и логи.
- Каждое новое поведение — тест в `server/test` (без сети: LLM подменяется). `npm test` перед коммитом.
- Не говорить «записала», если запись не прошла. Не выдумывать время, длительность, ежегодность.
