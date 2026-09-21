# Greenlight — small Node/Express app, no build step (plain JS/CSS
# served statically), so this is a single stage: install deps, copy source,
# run. Data (releases, audit log, Jira config) lives in /app/data, which
# docker-compose.yml mounts as a named volume so it survives rebuilds.

FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer only rebuilds when package*.json
# actually changes, not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Not root — small hardening step, doesn't change any app behavior.
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /app/data && chown -R app:app /app
USER app

VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
