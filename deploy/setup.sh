#!/usr/bin/env bash
# Первая настройка чистого VPS (Ubuntu 24.04 + Docker от Hostinger): файрвол, папка /srv, автообновления.
# Запускать один раз от root: bash setup.sh <домен горничной>
set -euo pipefail
DOMAIN="${1:?домен, например maid.example.tech}"

apt-get update -qq && apt-get install -y -qq ufw unattended-upgrades git curl >/dev/null
# Docker есть в шаблоне Hostinger; если нет — поставить.
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
docker compose version >/dev/null

# Файрвол: только SSH, HTTP, HTTPS.
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

# Обновления безопасности сами.
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

mkdir -p /srv
cd /srv
[ -d maid/.git ] || git clone https://github.com/GENKAIx/Maid-Bot.git maid
cp -n maid/deploy/docker-compose.yml /srv/docker-compose.yml
cp -n maid/deploy/Caddyfile /srv/Caddyfile
cp maid/deploy/deploy.sh /srv/deploy.sh && chmod +x /srv/deploy.sh
grep -q MAID_DOMAIN /srv/.env 2>/dev/null || echo "MAID_DOMAIN=$DOMAIN" >> /srv/.env
[ -f maid/.env ] || cp maid/.env.example maid/.env
echo "Готово. Дальше: впишите ключи в /srv/maid/.env и запустите /srv/deploy.sh"
