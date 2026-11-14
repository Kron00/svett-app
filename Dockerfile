# The svett server (apps/server). Coolify builds this file from the repo root.
FROM node:26.12.1-alpine

# pg_dump for the nightly backups. It must be at least the database's major version.
RUN apk add --no-cache postgresql18-client \
  && npm install --global --no-fund --no-audit pnpm@12.14.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile --prod --filter "@svett/server..."

COPY packages/core/src packages/core/src
COPY apps/server/src apps/server/src

RUN mkdir /backups && chown node:node /backups
USER node

ENV NODE_ENV=production PORT=3000 BACKUP_DIR=/backups
EXPOSE 3000
CMD ["node", "apps/server/src/main.ts"]
