#!/usr/bin/env bash
# Включить HTTPS без покупки домена: имя <ip-через-дефисы>.sslip.io само указывает на этот IP, Caddy выпускает сертификат
# (Let's Encrypt, при отказе — ZeroSSL). Старый адрес http://<ip> продолжает работать, пока все клиенты не перейдут на https.
# Запускать на сервере от root: bash /srv/maid/deploy/https.sh
set -euo pipefail
cd /srv
IP="$(curl -fsS4 https://api.ipify.org)"
HOST="${IP//./-}.sslip.io"
touch .env
grep -v '^MAID_DOMAIN=' .env > .env.new || true
echo "MAID_DOMAIN=\"$HOST, http://$IP\"" >> .env.new
mv .env.new .env
docker compose up -d --force-recreate caddy
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$HOST/api/public"; then echo "HTTPS работает: https://$HOST"; exit 0; fi
  sleep 3
done
echo "Сертификат ещё не выпущен. Логи: docker compose logs caddy --tail 40" >&2
exit 1
