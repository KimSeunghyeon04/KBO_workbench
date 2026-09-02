FROM mcr.microsoft.com/playwright:v1.62.0-noble

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

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

COPY apps/server apps/server
COPY packages packages
COPY database database

RUN pnpm build:server && chown -R pwuser:pwuser /app

ENV NODE_ENV=production

USER pwuser

EXPOSE 3000

CMD ["node", "apps/server/dist/main.js"]
