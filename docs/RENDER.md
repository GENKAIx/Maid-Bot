# Выкладка на Render — по шагам

Сервер — Web Service (Starter), база — Postgres (Basic). Всё описано в `render.yaml` в корне,
Render создаёт обе части сам. Цены сверить на render.com.

## 1. Репозиторий
Код должен лежать на GitHub (или GitLab). `.env`, `data/`, `web/dist` в git не идут — это нормально:
приложение собирается на Render при каждом деплое (`npm ci && npm run build`).

## 2. Создать службы
Render → **New → Blueprint** → выбрать репозиторий → Render покажет `maid` (web) и `maid-db` (Postgres) → **Apply**.
`DATABASE_URL` и `PUBLIC_URL` подставятся сами.

## 3. Секреты
В службе `maid` → **Environment** вписать:

| Переменная | Откуда |
|---|---|
| `LLM_API_KEY` | ключ OpenRouter (модель — `LLM_MODEL`, по умолчанию уже задана) |
| `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS` | если нужен бот; иначе оставить пустыми |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | у себя: `npm --workspace server run vapid` — скопировать три строки |

После сохранения служба перезапустится. В логах должно быть `[start] база: Postgres` и `[start] сервер: …`.

## 4. Учётная запись
Render → `maid` → **Shell**:
```
npm --workspace server run user -- create <логин> --password <пароль>
```
Если бот уже писал вам в Telegram и запись есть — добавьте `--chat <chat id>`, логин выдастся ей.

## 5. Перенос записей с ПК
У себя, с локальной базы, снять копию и перенести Excel ещё раз на Render — проще второе:
Shell → загрузить файл нельзя, поэтому запускаем импорт **с ПК на базу Render**:
```
set DATABASE_URL=<External Database URL из maid-db>
npm --workspace server run import -- "<файл.xlsx>" --login <логин>
```
Повторный запуск ничего не дублирует. (`set` — для cmd; в PowerShell `$env:DATABASE_URL="…"`.)

## 6. Телефон и ПК
- iPhone: Safari → адрес службы (`https://maid-….onrender.com`) → войти → «Поделиться» → **«На экран Домой»**.
  Открыть с экрана «Домой» → Настройки → **«Включить здесь»** → разрешить уведомления → «Проверить».
- ПК (браузер или приложение Electron): то же, «Включить здесь» в настройках. В настройках Electron — адрес сервера Render.
- Шаги с айфона: Быстрая команда шлёт `POST https://…/api/steps` с заголовком `Authorization: Bearer <ключ>`
  (ключ — `npm --workspace server run user -- token <логин> --label iphone` в Shell).
- Трекер ПК: в настройках приложения адрес сервера — Render, ключ — тот же способ.

## 7. Резервные копии
- Приложение → Настройки → **«Скачать копию»** — JSON со всеми записями.
- Если бот включён — каждую ночь в 03:30 копия приходит в Telegram файлом.
- Render Postgres Basic хранит свои снимки базы (Backups во вкладке базы).
- Восстановление из JSON — пока вручную (см. `docs/ROADMAP.md`).

## Если что-то не так
- `/healthz` отвечает `{"ok":true}` — сервер жив.
- Уведомления не приходят: Настройки → список устройств → «доставлено …»; на iPhone — только из приложения с экрана «Домой», iOS 16.4+.
- Логи: Render → `maid` → Logs (`[push]`, `[send]`, `[api]`).
