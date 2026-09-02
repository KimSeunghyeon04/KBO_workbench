import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@kbo/contracts": path.join(root, "packages/contracts/src/index.ts"),
      "@kbo/game-core": path.join(root, "packages/game-core/src/index.ts"),
      "@kbo/collection": path.join(root, "packages/collection/src/index.ts"),
      "@kbo/correction": path.join(root, "packages/correction/src/index.ts"),
      "@kbo/persistence": path.join(root, "packages/persistence/src/index.ts"),
      "@kbo/replay": path.join(root, "packages/replay/src/index.ts"),
    },
  },
  test: {
    env: { NODE_ENV: "test" },
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts", "apps/server/**/*.test.ts"],
    maxWorkers: 2,
  },
});
