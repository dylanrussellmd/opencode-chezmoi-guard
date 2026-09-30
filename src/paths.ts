/** Path normalisation shared by tool inputs and the chezmoi inventory. */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/** OpenCode's Global.Path.home: the test override wins over os.homedir(). */
export function hostHome(): string {
  return process.env.OPENCODE_TEST_HOME ?? homedir();
}

/** Mirrors the host's FileAccess resolvePath: `~`, `~/…`, absolute, then relative. */
export function expandPath(path: string, directory: string, home = hostHome()): string {
  if (path === "~") return resolve(home);
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(directory, path);
}

/**
 * Resolve symlinks in the path and every existing ancestor: a new file can
 * sit below a symlinked directory, and a dangling link can still create its
 * referent. Non-ENOENT errors and loops throw so callers fail closed.
 */
export function canonical(path: string, seen = new Set<string>()): string {
  if (seen.has(path) || seen.size >= 64)
    throw new Error("[chezmoi-guard] Cannot verify symlink chain; mutation blocked.");
  seen.add(path);
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

/**
 * Map key for path comparison. macOS and Windows default to case-insensitive
 * filesystems (and HFS+ stores NFD), so fold there. Folding on a
 * case-sensitive volume only over-blocks, which is the safe direction.
 */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" || platform === "win32" ? path.normalize("NFC").toLowerCase() : path;
}
