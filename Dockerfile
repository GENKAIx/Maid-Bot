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
COPY --from=build /app/web/dist web/dist
COPY deploy/entrypoint.sh /usr/local/bin/maid-entrypoint
RUN chmod +x /usr/local/bin/maid-entrypoint
ENV DB_FILE=/data/maid.sqlite WEB_DIR=/app/web/dist PORT=3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["maid-entrypoint"]
CMD ["node", "--import", "tsx", "server/src/index.ts"]
