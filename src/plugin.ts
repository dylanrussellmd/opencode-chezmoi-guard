/** Native OpenCode 2.0.8 guard: no redirection or subprocess writes. */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Plugin } from "@opencode/plugin";
import type { Result } from "@opencode/plugin/promise/tool";
import { managedSources, readSymlinkTarget, resolveSource } from "./chezmoi.js";
import { buildEncryptedGuidance, buildReadGuidance } from "./guidance.js";
import { patchHeaders } from "./patch.js";
import type { ResolveResult } from "./types.js";

const MUTATIONS = new Set(["edit", "write", "patch", "apply_patch"]);

// Resolve existing ancestors too: a new file can sit below a symlinked directory.
function canonical(path: string, seen = new Set<string>()): string {
  if (seen.has(path) || seen.size >= 64)
    throw new Error("[chezmoi-guard] Cannot verify symlink chain; mutation blocked.");
  seen.add(path);
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // realpath fails on dangling symlinks; writing them can still create the
    // managed referent, so inspect the link definition before parent fallback.
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return canonical(resolve(dirname(path), readlinkSync(path)), seen);
      }
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
    }
    const parent = dirname(path);
    return parent === path ? path : resolve(canonical(parent, seen), basename(path));
  }
}

function assertUnmanaged(path: string, sources: ReadonlyMap<string, ResolveResult>): void {
  const info = sources.get(path) ?? sources.get(canonical(path));
  if (!info) return;
  if (info.kind === "encrypted") throw new Error(buildEncryptedGuidance(path, info.sourcePath));
  throw new Error(
    [
      `[chezmoi-guard] Managed target mutation blocked: ${path}`,
      `Source (${info.kind}): ${info.sourcePath}`,
      "OpenCode 2.0.8 cannot authorize both source and target writes from this hook.",
      "Automatic redirection and apply are disabled. Read the source and explicitly edit it through normal permission-checked tools.",
      "For symlinks, inspect the link definition and explicitly edit its referent.",
      "Review the changes, then have the user synchronize this target with chezmoi. No source or target has been changed by this operation.",
    ].join("\n"),
  );
}

function readGuidance(target: string, seen = new Set<string>()): string {
  if (seen.has(target) || seen.size >= 32) return "";
  seen.add(target);
  const info = resolveSource(target);
  if (!info) return "";
  if (info.kind === "symlink") {
    const actual = readSymlinkTarget(info.sourcePath, target);
    return actual ? readGuidance(actual, seen) : "";
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
    ) => {
      if (isAbsolute(path)) return resolve(path);
      return resolve((await ctx.session.get({ sessionID })).location.directory, path);
    };

    await ctx.tool.hook("execute.before", async (event) => {
      if (!MUTATIONS.has(event.tool) || !event.input || typeof event.input !== "object") return;
      const input = event.input as Record<string, unknown>;
      const paths =
        event.tool === "patch" || event.tool === "apply_patch"
          ? typeof input.patchText === "string"
            ? patchHeaders(input.patchText).map((header) => header.path)
            : []
          : [typeof input.path === "string" ? input.path : input.filePath].filter(
              (path): path is string => typeof path === "string" && !!path,
            );
      if (!paths.length) return;
      // Fresh successful inventory is required for mutations. No availability
      // shortcut, cached negative result, or swallowed CLI/JSON failure.
      const sources = managedSources();
      for (const path of paths) assertUnmanaged(await absolute(path, event.sessionID), sources);
      // Original input remains intact, so the host checks original resources.
    });

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed" || event.tool !== "read") return;
      const input = event.input as { path?: unknown; filePath?: unknown } | null;
      const path = input?.path ?? input?.filePath;
      if (typeof path === "string" && path) {
        event.result = prepend(event.result, readGuidance(await absolute(path, event.sessionID)));
      }
    });
  },
};

export default ChezmoiGuardPlugin;
