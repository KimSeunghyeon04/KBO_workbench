FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN npm install --global pnpm@10.15.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/game-core/package.json packages/game-core/package.json
COPY packages/collection/package.json packages/collection/package.json
COPY packages/correction/package.json packages/correction/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/replay/package.json packages/replay/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json

RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/contracts packages/contracts
COPY packages/game-core packages/game-core

RUN pnpm --filter @kbo/contracts run build && pnpm --filter @kbo/game-core run build && pnpm build:web

FROM nginx:1.29-alpine

COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
