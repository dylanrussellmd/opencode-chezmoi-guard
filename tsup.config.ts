import { defineConfig } from "tsup";

/**
 * tsup config: bundle the plugin as a self-contained ESM module.
 *
 * Only @opencode-ai/plugin stays external — it is the host-provided peer
 * dep resolved by the opencode plugin loader. Everything else is inlined so
 * a partial dep install in opencode's plugin cache cannot break the entry
 * point at load time.
 */
export default defineConfig({
  entry: {
    plugin: "src/plugin.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  external: ["@opencode-ai/plugin"],
});
