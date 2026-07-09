/**
 * chezmoi-guard — opencode plugin entry.
 *
 * Intercepts `edit`, `write`, and `apply_patch` tool executions. If the
 * target file is chezmoi-managed, rewrites tool args to operate on the
 * actual editable source file (following symlinks, respecting modify
 * scripts, warning about templates) and then runs `chezmoi apply` to sync.
 *
 * Sync semantics (see C1 in the design notes):
 *   The guard edits the SOURCE before the target is touched, so the normal
 *   `chezmoi apply` is non-interactive (target is clean). The `--no-tty`
 *   flag is added so that if the target has drifted out-of-band (`MM`
 *   status — a prior manual edit, or a template/modify passthrough), apply
 *   FAILS SAFE: it exits non-zero and leaves the user's out-of-band edit
 *   intact, instead of hanging on a TTY prompt or (with --force) silently
 *   discarding their changes.
 *
 * @plugin chezmoi-guard
 * @version 1.0.0
 */

import { resolve as pathResolve } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { _log, chezmoi, chezmoiInstalled, readSymlinkTarget, resolveSource } from "./chezmoi.js";
import {
  buildEncryptedGuidance,
  buildModifyGuidance,
  buildSymlinkGuidance,
  buildTemplateGuidance,
  levelToVariant,
} from "./guidance.js";
import { extractPathsFromPatch } from "./patch.js";
import type { Redirect } from "./types.js";
import { VERSION } from "./version.js";

const INTERCEPTED_TOOLS = new Set(["edit", "write", "apply_patch"]);

/** Minimal shape of the opencode TUI toast client we use. */
interface PluginClientLike {
  tui?: {
    toast?: {
      show?: (input: {
        body: {
          message: string;
          variant: "info" | "success" | "warning" | "error";
          duration?: number;
        };
      }) => Promise<unknown> | unknown;
    };
  };
  app?: {
    log?: (input: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<unknown> | unknown;
  };
}

/** tool.execute.before output shape — args the tool will run with. */
interface BeforeOutput {
  args: Record<string, unknown>;
}

/** tool.execute.after output shape — what the agent sees. */
interface AfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

/**
 * Send a user-visible toast in the OpenCode TUI (best-effort). Falls back to
 * structured app.log, then to stderr. Never throws — a missing toast must
 * not block the actual edit.
 */
function notify(client: PluginClientLike, level: "error" | "warn" | "info", message: string): void {
  const variant = levelToVariant(level);
  try {
    const r = client.tui?.toast?.show?.({ body: { message, variant, duration: 4000 } });
    if (r && typeof r === "object" && "catch" in r && typeof r.catch === "function") {
      (r as Promise<unknown>).catch(() => {});
    }
  } catch {
    console.warn(`[chezmoi-guard] ${message}`);
  }
}

/**
 * Apply source→target. Uses --no-tty so a drifted target (`MM`) fails safe
 * (non-zero, leaves user edits intact) instead of hanging or discarding (C1).
 * Returns true on success, false on failure (drift or chezmoi error).
 */
function applyAndNotify(client: PluginClientLike, targetPath: string): boolean {
  const result = chezmoi(["apply", "--no-tty", targetPath]);
  if (result !== null) {
    notify(client, "info", `chezmoi apply succeeded: ${targetPath}`);
    _log(`applied: ${targetPath}`);
    return true;
  }
  notify(
    client,
    "error",
    `chezmoi apply could not sync ${targetPath} — target may have drifted (out-of-band edit). Your source change is saved; resolve with \`chezmoi apply ${targetPath}\` or \`chezmoi merge ${targetPath}\`.`,
  );
  _log(`apply failed (likely drift): ${targetPath}`);
  return false;
}

export const ChezmoiGuardPlugin: Plugin = async (ctx) => {
  const client = ctx.client as unknown as PluginClientLike;

  // key = `${sessionID}:${callID}` → redirect state
  const pending = new Map<string, Redirect>();

  // Best-effort init log.
  try {
    await client.app?.log?.({
      body: {
        service: "chezmoi-guard",
        level: "info",
        message: "init",
        extra: { version: VERSION, chezmoiInstalled: chezmoiInstalled() },
      },
    });
  } catch {
    /* logging must not block plugin startup */
  }

  return {
    // ── BEFORE hook ─────────────────────────────────────────────────────
    "tool.execute.before": async (input, output: BeforeOutput) => {
      if (!INTERCEPTED_TOOLS.has(input.tool)) return;
      const key = `${input.sessionID}:${input.callID}`;

      try {
        // ── apply_patch ─────────────────────────────────────────────────
        if (input.tool === "apply_patch") {
          const patchText = (output.args?.patchText as string | undefined) ?? "";
          if (!patchText) return;

          const targets = extractPathsFromPatch(patchText);
          const applyTargets = new Set<string>();
          let newText = patchText;
          let hasRemap = false;

          for (const rawPath of targets) {
            const targetPath = pathResolve(rawPath);
            const info = resolveSource(targetPath);
            if (!info) continue;

            if (info.kind === "run" || info.kind === "exact") {
              _log(`apply_patch skip (${info.kind}): ${targetPath}`);
              continue;
            }

            if (info.kind === "encrypted") {
              // Cannot rewrite a patch into ciphertext — leave path as-is and warn.
              notify(
                client,
                "error",
                `Encrypted file in patch: ${targetPath} — use \`chezmoi edit\``,
              );
              _log(`apply_patch encrypted (left as-is): ${targetPath}`);
              continue;
            }

            if (info.kind === "modify") {
              notify(
                client,
                "warn",
                `modify_ file in patch: ${targetPath} — changes may not persist`,
              );
              continue; // passthrough; no source remap, no apply
            }

            if (info.kind === "symlink") {
              const actualPath = readSymlinkTarget(info.sourcePath, targetPath);
              if (!actualPath) {
                notify(client, "error", `Could not read symlink target from ${info.sourcePath}`);
                continue;
              }
              newText = newText.split(targetPath).join(actualPath);
              applyTargets.add(targetPath);
              hasRemap = true;
              notify(client, "info", `symlink followed: ${targetPath} → ${actualPath}`);
              continue;
            }

            // template or normal → redirect patch path to source, apply after.
            newText = newText.split(targetPath).join(info.sourcePath);
            applyTargets.add(targetPath);
            hasRemap = true;
          }

          if (!hasRemap) return;
          output.args.patchText = newText;
          // H1: state via pending map, NOT smuggled through args.
          pending.set(key, { type: "patch", targets: [...applyTargets] });
          _log(`apply_patch: remapped ${applyTargets.size} path(s)`);
          return;
        }

        // ── edit / write ────────────────────────────────────────────────
        const targetPath = (output.args?.filePath as string | undefined) ?? "";
        if (!targetPath) return;

        const resolved = pathResolve(targetPath);
        const info = resolveSource(resolved);
        if (!info) return; // not managed

        // run_ / exact_ / (dirs already filtered by H2) → skip
        if (info.kind === "run" || info.kind === "exact") {
          _log(`skip ${input.tool} (${info.kind}): ${resolved}`);
          return;
        }

        // encrypted_ → BLOCK (do not redirect; warn). H3.
        if (info.kind === "encrypted") {
          pending.set(key, { type: "encrypted", source: info.sourcePath, target: resolved });
          notify(
            client,
            "error",
            `Encrypted file edit blocked: ${resolved} → use \`chezmoi edit\``,
          );
          _log(`encrypted block: ${resolved}`);
          return;
        }

        // modify_ → passthrough with warning
        if (info.kind === "modify") {
          pending.set(key, { type: "modify-warn", source: info.sourcePath, target: resolved });
          notify(client, "warn", `modify_ file edit: ${resolved} — changes may not persist`);
          _log(`modify passthrough: ${resolved}`);
          return;
        }

        // symlink_ → follow to actual file
        if (info.kind === "symlink") {
          const actualPath = readSymlinkTarget(info.sourcePath, resolved);
          if (!actualPath) {
            notify(client, "error", `Could not read symlink target from ${info.sourcePath}`);
            return;
          }
          output.args.filePath = actualPath;
          pending.set(key, {
            type: "symlink",
            source: info.sourcePath,
            target: resolved,
            actual: actualPath,
          });
          notify(client, "info", `symlink followed: ${resolved} → ${actualPath}`);
          _log(`redirect symlink: ${resolved} → ${actualPath}`);
          return;
        }

        // template → write warns (hits rendered target), edit redirects to source
        if (info.kind === "template") {
          if (input.tool === "write") {
            pending.set(key, {
              type: "tmpl-write-warn",
              source: info.sourcePath,
              target: resolved,
            });
            notify(
              client,
              "warn",
              `Template write: ${resolved} → changes lost on apply; edit source ${info.sourcePath}`,
            );
            _log(`tmpl-write passthrough: ${resolved}`);
            return;
          }
          output.args.filePath = info.sourcePath;
          pending.set(key, { type: "tmpl-edit", source: info.sourcePath, target: resolved });
          notify(client, "info", `Template edit redirected: ${resolved} → ${info.sourcePath}`);
          _log(`redirect edit (template): ${resolved} → ${info.sourcePath}`);
          return;
        }

        // Normal file → redirect to source, apply after
        output.args.filePath = info.sourcePath;
        pending.set(key, { type: "apply", source: info.sourcePath, target: resolved });
        notify(client, "info", `chezmoi redirect: ${resolved} → ${info.sourcePath}`);
        _log(`redirect ${input.tool}: ${resolved} → ${info.sourcePath}`);
      } catch (err) {
        _log(`before-hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    // ── AFTER hook ──────────────────────────────────────────────────────
    "tool.execute.after": async (input, output: AfterOutput | undefined) => {
      const key = `${input.sessionID}:${input.callID}`;
      const redirect = pending.get(key);
      if (!redirect) return;
      pending.delete(key);

      // output may be undefined for some tool paths; guard defensively.
      const out: AfterOutput = output ?? {
        title: "",
        output: "",
        metadata: {},
      };

      try {
        switch (redirect.type) {
          case "patch": // H1: apply each unique target
            for (const t of redirect.targets) applyAndNotify(client, t);
            return;

          case "encrypted":
            out.output =
              buildEncryptedGuidance(redirect.target, redirect.source) + (out.output ?? "");
            return;

          case "tmpl-write-warn":
            out.output =
              buildTemplateGuidance(redirect.target, redirect.source, "write") + (out.output ?? "");
            return;

          case "tmpl-edit":
            out.output =
              buildTemplateGuidance(redirect.target, redirect.source, "edit") + (out.output ?? "");
            applyAndNotify(client, redirect.target);
            return;

          case "symlink":
            out.output =
              buildSymlinkGuidance(redirect.target, redirect.source, redirect.actual) +
              (out.output ?? "");
            applyAndNotify(client, redirect.target);
            return;

          case "modify-warn":
            out.output = buildModifyGuidance(redirect.target, redirect.source) + (out.output ?? "");
            return;

          case "apply":
            applyAndNotify(client, redirect.target);
            return;
        }
      } catch (err) {
        _log(`after-hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
};

export default ChezmoiGuardPlugin;
