import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      // plugin.ts is the opencode runtime hook glue (tool.execute.before/after
      // orchestration) — exercising it needs a mocked opencode client + chezmoi
      // binary harness, not a unit test. types.ts is a pure type re-export with
      // no runtime code. Both are excluded from the coverage gate, mirroring
      // agent-router's exclusion of version.ts / seeds.
      exclude: ["src/plugin.ts", "src/types.ts", "src/version.ts", "**/*.d.ts"],
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
      },
    },
  },
});
