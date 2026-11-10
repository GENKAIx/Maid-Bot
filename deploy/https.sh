#!/usr/bin/env bash
# Включить HTTPS без покупки домена: имя <ip-через-дефисы>.sslip.io само указывает на этот IP, Caddy выпускает сертификат
# (Let's Encrypt, при отказе — ZeroSSL). Старый адрес http://<ip> больше не обслуживается: Caddy перенаправляет его на https
# (ключ и дневник по нему открытым текстом не ходят; окно настроек программы на ПК предупреждает о таком адресе).
# Запускать на сервере от root: bash /srv/maid/deploy/https.sh
set -euo pipefail
cd /srv
IP="$(curl -fsS4 https://api.ipify.org)"
HOST="${IP//./-}.sslip.io"
touch .env
# Caddyfile и docker-compose.yml в /srv — копии из репозитория; новые (с перенаправлением http://<ip>) — сюда, старые — в .bak.
for f in Caddyfile docker-compose.yml; do [ -f "$f" ] && cp "$f" "$f.bak"; cp "maid/deploy/$f" "$f"; done
grep -v -e '^MAID_DOMAIN=' -e '^MAID_OLD=' -e '^MAID_HOST=' .env > .env.new || true
{ echo "MAID_DOMAIN=\"$HOST\""; echo "MAID_HOST=\"$HOST\""; echo "MAID_OLD=\"http://$IP\""; } >> .env.new
mv .env.new .env
docker compose up -d --force-recreate caddy
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$HOST/api/public"; then echo "HTTPS работает: https://$HOST"; exit 0; fi
  sleep 3
done
echo "Сертификат ещё не выпущен. Логи: docker compose logs caddy --tail 40" >&2
exit 1
