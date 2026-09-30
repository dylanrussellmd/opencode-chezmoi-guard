import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/types.ts", "src/version.ts", "**/*.d.ts"],
      thresholds: {
        lines: 95,
        branches: 90,
        functions: 95,
        statements: 95,
      },
    },
  },
});
