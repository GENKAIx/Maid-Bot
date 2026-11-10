#!/bin/sh
# Сервер работает от имени node, а не root. Том /data мог быть создан раньше от root — отдать его node и запустить.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec su-exec node "$@"
fi
exec "$@"
