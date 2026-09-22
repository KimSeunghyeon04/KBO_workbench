import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/performance/analytics.benchmark.ts"],
    maxWorkers: 1,
    testTimeout: 180000,
  },
});
