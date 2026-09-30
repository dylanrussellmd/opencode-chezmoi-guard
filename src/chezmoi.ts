/**
 * chezmoi CLI wrapper, managed-path inventory and source classification.
 *
 * Every subprocess goes through `run()`: argv only (no shell), `--no-tty`,
 * stdin closed, bounded time and output. Mutations use `managedSources()`,
 * a fresh inventory that fails closed. Read advisories use `cachedSources()`,
 * a short-lived copy that fails open.
 */

import { type ExecFileException, execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonical, pathKey } from "./paths.js";
import type { ResolveResult, SourceKind } from "./types.js";

/** A prompting template, pinentry or password manager must not hang the host. */
export const TIMEOUT_MS = 15_000;
/** Inventories grow with the source tree; the Node default of 1 MiB is too small. */
export const MAX_BUFFER = 64 * 1024 * 1024;
const CACHE_TTL_MS = 30_000;

export type RunResult = { ok: true; stdout: string } | { ok: false; reason: string };
export type Inventory = ReadonlyMap<string, ResolveResult>;

function failureReason(error: ExecFileException, stderr: string): string {
  if (error.code === "ENOENT") return "chezmoi not found on PATH";
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return `output exceeded ${MAX_BUFFER / 1024 / 1024} MiB`;
  if (error.killed) return `timed out after ${TIMEOUT_MS / 1000}s`;
  const detail = stderr.trim().split("\n")[0]?.slice(0, 200);
  const status = typeof error.code === "number" ? `exit status ${error.code}` : error.message;
  return detail ? `${status}: ${detail}` : status;
}

/** Run chezmoi with an argv array; never throws. */
export function run(args: string[]): Promise<RunResult> {
  return new Promise((done) => {
    const child = execFile(
      "chezmoi",
      ["--no-tty", ...args],
      { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        done(
          error
            ? { ok: false, reason: failureReason(error, String(stderr ?? "")) }
            : { ok: true, stdout: String(stdout).trim() },
        );
      },
    );
    child?.stdin?.end();
  });
}

// ─── Classification ─────────────────────────────────────────────────────────
// chezmoi attributes are filename prefixes, so only the basename is parsed:
// an ancestor directory such as `encrypted_dot_ssh/` or `exact_dot_config/`
// says nothing about its descendants. Prefixes follow chezmoi's fixed order
// per target type (source-state attribute table); `dot_`, `literal_` or any
// other text ends parsing. The most edit-restrictive kind wins: encrypted,
// run, modify, symlink, template, normal.

const FILE_ATTRIBUTES = ["encrypted_", "private_", "readonly_", "empty_", "executable_"];
const TYPES: readonly [string, readonly string[]][] = [
  ["create_", FILE_ATTRIBUTES],
  ["modify_", ["encrypted_", "private_", "readonly_", "executable_"]],
  ["remove_", []],
  ["run_", ["once_", "onchange_", "before_", "after_"]],
  ["symlink_", []],
];

export const ENCRYPTED_SUFFIX_RE = /\.(age|asc)$/;

function attributes(base: string): Set<string> {
  const [type, following] = TYPES.find(([prefix]) => base.startsWith(prefix)) ?? [
    "",
    FILE_ATTRIBUTES,
  ];
  const found = new Set<string>(type ? [type] : []);
  let rest = base.slice(type.length);
  for (const prefix of following) {
    if (!rest.startsWith(prefix)) continue;
    found.add(prefix);
    rest = rest.slice(prefix.length);
  }
  return found;
}

export function classifyKind(sourcePath: string): SourceKind {
  const base = basename(sourcePath);
  const found = attributes(base);
  if (found.has("encrypted_") || ENCRYPTED_SUFFIX_RE.test(base)) return "encrypted";
  if (found.has("run_")) return "run";
  if (found.has("modify_")) return "modify";
  if (found.has("symlink_")) return "symlink";
  // A `.literal` suffix stops suffix parsing, so `x.tmpl.literal` is not a template.
  if (!base.endsWith(".literal") && base.endsWith(".tmpl")) return "template";
  return "normal";
}

// ─── Inventory ──────────────────────────────────────────────────────────────

const INVENTORY_ARGS = ["managed", "--include=files,symlinks", "--path-style=all", "--format=json"];

function invalid(): Error {
  return new Error(
    "[chezmoi-guard] Cannot verify managed paths: invalid chezmoi inventory. Mutation blocked.",
  );
}

/**
 * Key each entry by its reported path and by the path with its *parent*
 * resolved, so a symlinked destination directory (e.g. /home → /var/home)
 * still matches. The final component is deliberately not followed: a managed
 * symlink's referent is a separate, possibly unmanaged file.
 */
function parseInventory(output: string): Map<string, ResolveResult> {
  let inventory: unknown;
  try {
    inventory = JSON.parse(output);
  } catch {
    throw invalid();
  }
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) throw invalid();
  const sources = new Map<string, ResolveResult>();
  for (const entry of Object.values(inventory)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.absolute !== "string" ||
      !isAbsolute(entry.absolute) ||
      typeof entry.sourceAbsolute !== "string" ||
      !isAbsolute(entry.sourceAbsolute)
    ) {
      throw invalid();
    }
    const info = { sourcePath: entry.sourceAbsolute, kind: classifyKind(entry.sourceAbsolute) };
    const target = resolve(entry.absolute);
    sources.set(pathKey(target), info);
    sources.set(pathKey(resolve(canonical(dirname(target)), basename(target))), info);
  }
  return sources;
}

let cached: { sources: Inventory | null; at: number } | undefined;

/** Mutations require a fresh, validated inventory; failures are never unmanaged. */
export async function managedSources(): Promise<Inventory> {
  const result = await run(INVENTORY_ARGS);
  if (!result.ok) {
    throw new Error(
      `[chezmoi-guard] Cannot verify managed paths: chezmoi lookup failed (${result.reason}). Mutation blocked; repair chezmoi configuration or availability and retry.`,
    );
  }
  const sources = parseInventory(result.stdout);
  cached = { sources, at: Date.now() };
  return sources;
}

/** Best-effort inventory for read advisories; null when chezmoi is unusable. */
export async function cachedSources(): Promise<Inventory | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.sources;
  try {
    return await managedSources();
  } catch {
    cached = { sources: null, at: Date.now() };
    return null;
  }
}

/** Test hook: forget the advisory cache. */
export function resetCache(): void {
  cached = undefined;
}

/**
 * Find a path in the inventory as given, with its parent resolved, and fully
 * resolved (an alias or symlinked ancestor pointing at a managed file).
 */
export function lookup(sources: Inventory, path: string): ResolveResult | undefined {
  return (
    sources.get(pathKey(path)) ??
    sources.get(pathKey(resolve(canonical(dirname(path)), basename(path)))) ??
    sources.get(pathKey(canonical(path)))
  );
}

/**
 * For symlink sources, read (or render) the link definition and resolve a
 * relative referent against the symlink's own directory.
 * @returns the absolute referent, or null when it cannot be determined.
 */
export async function readSymlinkTarget(
  sourcePath: string,
  targetPath: string,
): Promise<string | null> {
  let linkContent: string;
  if (sourcePath.endsWith(".tmpl")) {
    const result = await run(["execute-template", "--file", "--", sourcePath]);
    if (!result.ok) return null;
    linkContent = result.stdout;
  } else {
    try {
      linkContent = (await readFile(sourcePath, "utf8")).trim();
    } catch {
      return null;
    }
  }
  return linkContent ? resolve(dirname(targetPath), linkContent) : null;
}
