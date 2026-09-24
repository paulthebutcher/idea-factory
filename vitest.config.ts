import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/acceptance/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    env: { SEARCH_MODE: "replay", MODEL_MODE: "replay" },
  },
});
