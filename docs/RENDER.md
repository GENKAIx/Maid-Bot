# Выкладка: VPS Hostinger (сейчас) и Render (запасной вариант)

## Сейчас: VPS Hostinger, по IP, без домена (08.11.2026)
- Сервер: KVM 1, Германия, Ubuntu 24.04 + Docker, IP `187.126.11.122`. Вход — SSH-ключ `~/.ssh/maid_vps` с ПК пользователя
  (`ssh -i ~/.ssh/maid_vps root@187.126.11.122`); пароль root — у пользователя.
- На сервере: `/srv/docker-compose.yml` (Caddy на 80/443 + контейнер `maid`), `/srv/Caddyfile`, `/srv/.env` (`MAID_DOMAIN=:80` —
  без домена, обычный http), код — `/srv/maid` (клон GitHub), ключи приложения — `/srv/maid/.env`, база — том `srv_maid_data`
  (`/data/maid.sqlite` в контейнере).
- Обновить: `ssh … root@187.126.11.122 /srv/deploy.sh` (git pull, пересборка образа, перезапуск).
- Логи: `docker compose -f /srv/docker-compose.yml logs maid --tail 50`. Команды внутри: `docker compose -f /srv/docker-compose.yml
  exec maid node --import tsx server/src/user.ts list` (так же `import.ts`, `backup.ts`).
- База перенесена с ПК как есть (пользователь #1 genkai со всеми записями из Excel).
- Файрвол: SSH, 80, 443. Автообновления безопасности включены.
- Ключи заполнены (08.11.2026): OpenRouter `anthropic/claude-sonnet-5.5`, бот @gren_kain_bot (тот же, что был у старого бота; старый
  сервис на Render остановлен — Suspend, можно вернуть). Шаблон ключей — `secrets/vps.env` на ПК (в git не идёт), на сервер —
  `scp` и перезапуск `docker compose up -d --force-recreate maid`.
- Приложение на ПК: настроено на `http://187.126.11.122` (`%APPDATA%\maid-desktop\settings.json`), ключ выпущен `user.ts token genkai --label desktop`.
- **HTTPS (09.11.2026)**: `https://187-126-11-122.sslip.io` — бесплатное имя sslip.io само указывает на IP, сертификат Let's Encrypt
  Caddy выпускает и продлевает сам. Включено `deploy/https.sh` (в `/srv/.env`: `MAID_DOMAIN="187-126-11-122.sslip.io, http://187.126.11.122"`).
  Старый `http://187.126.11.122` пока работает для старых клиентов; ПК и виджет iPhone переведены на https. Свой домен позже —
  поменять `MAID_DOMAIN` и `docker compose up -d --force-recreate caddy`.

---

## Запасной вариант: Render — по шагам

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
