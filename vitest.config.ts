import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    // Integration files replace process-wide database and scanner state.
    // Running files serially prevents resource contention and cross-database
    // timing interference while preserving concurrency inside scanner tests.
    fileParallelism: false,
  },
});
