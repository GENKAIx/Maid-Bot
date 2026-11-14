#!/usr/bin/env bash
# Обновить горничную на VPS: взять код из GitHub, пересобрать образ, перезапустить. Запускать на сервере: /srv/deploy.sh
set -euo pipefail
cd /srv
if [ -d maid/.git ]; then git -C maid pull --ff-only; else git clone https://github.com/GENKAIx/Maid-Bot.git maid; fi
# Сам скрипт в /srv — копия из репозитория: новая версия — заменить себя и запуститься заново.
if ! cmp -s maid/deploy/deploy.sh /srv/deploy.sh; then cp maid/deploy/deploy.sh /srv/deploy.sh && chmod +x /srv/deploy.sh && exec /srv/deploy.sh; fi
[ -f maid/.env ] || { cp maid/.env.example maid/.env; echo "Создан /srv/maid/.env — впишите ключи и запустите снова"; exit 1; }
# Сначала собрать: в сборке идут проверки (типы, тесты — Dockerfile, этап check). Не прошли — выходим, работает прежняя версия.
if ! docker compose build; then echo "Проверки или сборка не прошли — сервер не обновлён, работает прежняя версия." >&2; exit 1; fi
docker compose up -d --remove-orphans
# Дождаться, пока новый контейнер ответит на /healthz (HEALTHCHECK в Dockerfile).
for i in $(seq 1 40); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q maid)" 2>/dev/null || echo none)"
  [ "$st" = healthy ] && break
  sleep 3
done
docker image prune -f >/dev/null
# Кэш сборки копится с каждой выкладкой (было 14 ГБ) — держать не больше 2 ГБ: хватает, чтобы сборка оставалась быстрой.
docker builder prune -f --max-used-space 2GB >/dev/null
docker compose ps
[ "$st" = healthy ] || { echo "Новый контейнер не ответил на /healthz. Логи: docker compose logs maid --tail 60" >&2; exit 1; }
