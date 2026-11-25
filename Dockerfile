# Горничная: сервер + собранное веб-приложение в одном образе.
# Сборка: docker compose build (см. deploy/); данные (SQLite) — в томе /data.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY desktop/package.json desktop/
RUN npm ci --ignore-scripts
COPY web web
RUN npm --workspace web run build

# Проверки перед выпуском: типы и тесты сервера (сайт проверяет типы в своей сборке выше). Упало — образ не собран,
# и /srv/deploy.sh оставляет работать прежний контейнер.
FROM build AS check
COPY server server
# Тест живого показа (server/test/preview.test.ts): заглушка window.maid сверяется с preload.js и скриптами виджета.
COPY desktop/renderer desktop/renderer
COPY desktop/src/preload.js desktop/src/preload.js
COPY desktop/assets/star.png desktop/assets/star.png
RUN npm --workspace server run typecheck && npm --workspace server test

FROM node:22-alpine
ENV NODE_ENV=production
# su-exec: entrypoint отдаёт том /data пользователю node и запускает сервер уже не от root.
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY desktop/package.json desktop/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server server
# Живой показ виджета в «Витрине» админки (server/src/preview.ts): только renderer и нужные ему картинки, шрифты и звуки,
# без исходников программы (desktop/src) и установщиков.
COPY desktop/renderer desktop/renderer
COPY desktop/assets/maid desktop/assets/maid
COPY desktop/assets/inbox desktop/assets/inbox
COPY desktop/assets/fonts desktop/assets/fonts
COPY desktop/assets/sounds desktop/assets/sounds
COPY desktop/assets/star.png desktop/assets/star.png
COPY --from=check /app/web/dist web/dist
COPY deploy/entrypoint.sh /usr/local/bin/maid-entrypoint
RUN chmod +x /usr/local/bin/maid-entrypoint
ENV DB_FILE=/data/maid.sqlite WEB_DIR=/app/web/dist DESKTOP_DIR=/data/desktop PORT=3000
# Версия сервера для админки (раздел «Здоровье»): коммит и время сборки — из deploy/deploy.sh (--build-arg); нет — «—».
ARG MAID_VERSION=""
ARG BUILT_AT=""
ENV MAID_VERSION=$MAID_VERSION BUILT_AT=$BUILT_AT
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["maid-entrypoint"]
CMD ["node", "--import", "tsx", "server/src/index.ts"]
