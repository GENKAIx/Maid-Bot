#!/usr/bin/env bash
# Обновить горничную на VPS: взять код из GitHub, пересобрать образ, перезапустить. Запускать на сервере: /srv/deploy.sh
set -euo pipefail
cd /srv
if [ -d maid/.git ]; then git -C maid pull --ff-only; else git clone https://github.com/GENKAIx/Maid-Bot.git maid; fi
[ -f maid/.env ] || { cp maid/.env.example maid/.env; echo "Создан /srv/maid/.env — впишите ключи и запустите снова"; exit 1; }
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose ps
