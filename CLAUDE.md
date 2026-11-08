# Горничная 2.0 — правила проекта

- Общайся с пользователем по-русски, кратко.
- Архитектура, решения и этапы — `docs/АРХИТЕКТУРА.md`; менять вместе с кодом.
- Старый бот `C:\Users\fazek\Desktop\CodexProject` (Render, Apps Script, Google Таблица) **не трогать** — он работает.
  Материалы прошлого: Obsidian `C:\Users\fazek\Desktop\Obsidian TG\Genkai OBSIDIAN\Telegram tab bot\` (только чтение).
- Хранилище — `server/src/db.ts` (все методы асинхронные): SQLite у себя (`DB_FILE`) или Postgres на Render (`DATABASE_URL`).
  SQL пишется один раз, `driver.ts` переводит его под базу. Новый метод — тест на обеих (`test/data.test.ts`, Postgres — PGlite).
  Google Таблицы больше нет.
- Секреты только в `.env` и `secrets/` (в git не идут). Не писать их в документы и логи.
- Каждое новое поведение — тест в `server/test` (без сети: LLM подменяется). `npm test` перед коммитом.
- Не говорить «записала», если запись не прошла. Не выдумывать время, длительность, ежегодность.
