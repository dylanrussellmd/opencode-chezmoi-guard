/**
 * chezmoi CLI wrapper + source resolution + classification.
 *
 * All chezmoi subprocess calls go through `chezmoi()` — no shell, argv
 * array only (no injection, C2). A short TTL cache avoids re-running
 * `chezmoi managed` for the same target within a session, while still
 * picking up state changes mid-session (M3).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import type { ResolveResult, SourceKind } from "./types.js";

// ─── Prefix patterns ────────────────────────────────────────────────────────
// Order matters: a single source filename can carry several prefixes (e.g.
// encrypted_private_dot_x.tmpl), so the most edit-restrictive classification
// must win. classifyKind() checks encrypted before template before others.

export const PREFIX_RE = {
  run: /(?:^|\/)run_/,
  modify: /(?:^|\/)modify_/,
  symlink: /(?:^|\/)symlink_/,
  exact: /(?:^|\/)exact_/,
  encrypted: /(?:^|\/)encrypted_/,
} as const;

export const ENCRYPTED_SUFFIX_RE = /\.(age|asc)$/;

const CACHE_TTL_MS = 30 * 1000; // short TTL: chezmoi state can change mid-session (M3)

// ─── State ──────────────────────────────────────────────────────────────────

const DEBUG = process.env.CHEZMOI_GUARD_DEBUG === "1";
let chezmoiAvailable: boolean | null = null; // null = unchecked, true/false after first probe
const cache = new Map<string, { result: ResolveResult | null; checkedAt: number }>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Debug-only stderr logger. Enable with CHEZMOI_GUARD_DEBUG=1. */
export function _log(msg: string): void {
  if (DEBUG) console.warn(`[chezmoi-guard] ${msg}`);
}

/**
 * Run the chezmoi CLI with an argv array (no shell → no injection, C2).
 * Returns trimmed stdout, or null on any failure (non-zero exit, missing
 * binary). On ENOENT the binary is remembered as missing so subsequent
 * calls short-circuit for the rest of the session.
 * @param args argv passed to `chezmoi`
 */
export function chezmoi(args: string[]): string | null {
  try {
    const out = execFileSync("chezmoi", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    chezmoiAvailable = true; // mark availability on first successful call (L3)
    return out.trim();
  } catch (err) {
    // ENOENT = binary not on PATH → remember and stop trying this session.
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      chezmoiAvailable = false;
    }
    return null;
  }
}

/** Cheap one-time availability gate so we skip work when chezmoi isn't installed. */
export function chezmoiInstalled(): boolean {
  if (chezmoiAvailable !== null) return chezmoiAvailable;
  // A lightweight call that also seeds chezmoiAvailable via chezmoi().
  chezmoi(["--version"]);
  return chezmoiAvailable === true;
}

/**
 * Classify a source path into an edit-handling kind.
 *
 * Encrypted is checked first (most restrictive — cannot edit ciphertext at
 * all). Then script/structural prefixes, since modify_/run_ may carry .tmpl.
 * Template (.tmpl suffix) is checked last.
 */
export function classifyKind(sourcePath: string): SourceKind {
  if (PREFIX_RE.encrypted.test(sourcePath) || ENCRYPTED_SUFFIX_RE.test(sourcePath)) {
    return "encrypted";
  }
  if (PREFIX_RE.run.test(sourcePath)) return "run";
  if (PREFIX_RE.modify.test(sourcePath)) return "modify";
  if (PREFIX_RE.symlink.test(sourcePath)) return "symlink";
  if (PREFIX_RE.exact.test(sourcePath)) return "exact";
  if (sourcePath.endsWith(".tmpl")) return "template";
  return "normal";
}

/**
 * Resolve a target path to its chezmoi source path with caching.
 * Restricts to files+symlinks (H2) so directories/scripts never misclassify.
 * @returns the source path + kind, or null if the target is not managed.
 */
export function resolveSource(targetPath: string): ResolveResult | null {
  if (!chezmoiInstalled()) return null;

  const now = Date.now();
  const cached = cache.get(targetPath);
  if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const sourcePath = chezmoi([
    "managed",
    "--include=files,symlinks",
    "--path-style=source-absolute",
    targetPath,
  ]);

  if (!sourcePath) {
    // Cache negative result; the TTL still applies on read.
    cache.set(targetPath, { result: null, checkedAt: now });
    return null;
  }

  // A single managed file/symlink target yields exactly one line; guard anyway.
  const firstLine = sourcePath.split("\n")[0]?.trim() ?? "";
  if (!firstLine) {
    cache.set(targetPath, { result: null, checkedAt: now });
    return null;
  }
  const result: ResolveResult = {
    sourcePath: firstLine,
    kind: classifyKind(firstLine),
    checkedAt: now,
  };
  cache.set(targetPath, { result, checkedAt: now });
  return result;
}

/**
 * For symlink sources, read the source file to get the link target,
 * resolving relative targets against the symlink's own directory (H4).
 * @returns the absolute path the symlink points to, or null on read failure.
 */
export function readSymlinkTarget(sourcePath: string, targetPath: string): string | null {
  try {
    const linkContent = readFileSync(sourcePath, "utf8").trim();
    if (!linkContent) return null;
    return pathResolve(dirname(targetPath), linkContent);
  } catch {
    return null;
  }
}
