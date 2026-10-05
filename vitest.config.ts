import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/worker/tests/**/*.test.ts"],
    environment: "node",
  },
});
