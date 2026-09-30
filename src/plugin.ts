/** Native OpenCode 2 guard: no redirection or subprocess writes. */
import type { Plugin } from "@opencode/plugin";
import type { Result } from "@opencode/plugin/promise/tool";
import {
  type Inventory,
  cachedSources,
  lookup,
  managedSources,
  readSymlinkTarget,
} from "./chezmoi.js";
import { buildEncryptedGuidance, buildReadGuidance } from "./guidance.js";
import { patchHeaders } from "./patch.js";
import { expandPath } from "./paths.js";

// `apply_patch` is not a 2.0.19 tool; it is kept for hosts or plugins that
// register a compatible patch tool under that name.
const MUTATIONS = new Set(["edit", "write", "patch", "apply_patch"]);
const PATCH_TOOLS = new Set(["patch", "apply_patch"]);

/**
 * Extract every target path from a mutation's input. An input the guard
 * cannot interpret (schema drift, a new field name, an unparsed patch) is
 * refused rather than passed through: the host would reject a truly invalid
 * input anyway, but a valid one the guard misread would bypass it.
 */
function mutationPaths(tool: string, input: unknown): string[] {
  const fields = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const paths = PATCH_TOOLS.has(tool)
    ? typeof fields.patchText === "string"
      ? patchHeaders(fields.patchText).map((header) => header.path)
      : []
    : [fields.path, fields.filePath].filter(
        (path): path is string => typeof path === "string" && !!path,
      );
  if (!paths.length) {
    throw new Error(
      `[chezmoi-guard] Cannot determine the target path of this ${tool} call; mutation blocked. Use the tool's documented input (${PATCH_TOOLS.has(tool) ? "patchText with *** Add/Update/Delete File headers" : "path"}).`,
    );
  }
  return paths;
}

function assertUnmanaged(path: string, sources: Inventory): void {
  const info = lookup(sources, path);
  if (!info) return;
  if (info.kind === "encrypted") throw new Error(buildEncryptedGuidance(path, info.sourcePath));
  throw new Error(
    [
      `[chezmoi-guard] Managed target mutation blocked: ${path}`,
      `Source (${info.kind}): ${info.sourcePath}`,
      "OpenCode's plugin API cannot authorize both source and target writes from this hook.",
      "Automatic redirection and apply are disabled. Read the source and explicitly edit it through normal permission-checked tools.",
      "For symlinks, inspect the link definition and explicitly edit its referent.",
      "Review the changes, then have the user synchronize this target with chezmoi. No source or target has been changed by this operation.",
    ].join("\n"),
  );
}

async function readGuidance(
  sources: Inventory,
  target: string,
  seen = new Set<string>(),
): Promise<string> {
  if (seen.has(target) || seen.size >= 32) return "";
  seen.add(target);
  const info = lookup(sources, target);
  if (!info) return "";
  if (info.kind === "symlink") {
    const actual = await readSymlinkTarget(info.sourcePath, target);
    return actual ? readGuidance(sources, actual, seen) : "";
  }
  if (info.kind === "template" || info.kind === "modify" || info.kind === "encrypted") {
    return buildReadGuidance(target, info.sourcePath, info.kind);
  }
  return "";
}

function prepend(result: Result, text: string): Result {
  if (!text) return result;
  return {
    ...result,
    content:
      typeof result.content === "string"
        ? text + result.content
        : [{ type: "text", text }, ...(result.content ?? [])],
  };
}

export const ChezmoiGuardPlugin: Plugin.Plugin = {
  id: "chezmoi-guard",
  async setup(ctx) {
    const absolute = async (
      path: string,
      sessionID: Parameters<typeof ctx.session.get>[0]["sessionID"],
    ) => expandPath(path, (await ctx.session.get({ sessionID })).location.directory);

    await ctx.tool.hook("execute.before", async (event) => {
      if (!MUTATIONS.has(event.tool)) return;
      const paths = mutationPaths(event.tool, event.input);
      // Fresh successful inventory is required for mutations. No availability
      // shortcut, cached negative result, or swallowed CLI/JSON failure.
      const sources = await managedSources();
      for (const path of paths) assertUnmanaged(await absolute(path, event.sessionID), sources);
      // Original input remains intact, so the host checks original resources.
    });

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed" || event.tool !== "read") return;
      const input = event.input as { path?: unknown; filePath?: unknown } | null;
      const path = input?.path ?? input?.filePath;
      if (typeof path !== "string" || !path) return;
      // Advisories are best-effort: any failure leaves the read result as is.
      try {
        const sources = await cachedSources();
        if (!sources) return;
        const guidance = await readGuidance(sources, await absolute(path, event.sessionID));
        event.result = prepend(event.result, guidance);
      } catch {
        // Unresolvable path or symlink loop: no advisory.
      }
    });
  },
};

export default ChezmoiGuardPlugin;
