#!/usr/bin/env bash
# Поднять базу горничной из снимка (snapshots/maid-ГГГГ-ММ-ДД.sqlite или копии с ПК — deploy/pull-backup.ps1).
# Запускать на сервере от root: bash /srv/maid/deploy/restore.sh /путь/к/снимку.sqlite
# Текущая база не удаляется: остаётся рядом как maid.sqlite.before-restore-<время>.
set -euo pipefail
FILE="$(realpath "${1:?укажите файл снимка .sqlite}")"
cd /srv
echo "Проверяю снимок…"
docker compose run --rm --no-deps -T -v "$FILE:/restore.sqlite:ro" --entrypoint node maid \
  --import tsx server/src/snapshot.ts check /restore.sqlite
STAMP="$(date +%Y%m%d-%H%M%S)"
docker compose stop maid
docker compose run --rm --no-deps -T -v "$FILE:/restore.sqlite:ro" --entrypoint sh maid -c "
  set -e
  for f in maid.sqlite maid.sqlite-wal maid.sqlite-shm; do [ -f /data/\$f ] && mv /data/\$f /data/\$f.before-restore-$STAMP || true; done
  cp /restore.sqlite /data/maid.sqlite
  chown node:node /data/maid.sqlite"
docker compose up -d maid
for i in $(seq 1 40); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q maid)" 2>/dev/null || echo none)"
  [ "$st" = healthy ] && { echo "База поднята из $FILE. Прежняя — /data/maid.sqlite.before-restore-$STAMP"; exit 0; }
  sleep 3
done
echo "Сервер не ответил на /healthz. Логи: docker compose logs maid --tail 60. Вернуть прежнюю базу — тем же скриптом с файлом before-restore." >&2
exit 1
