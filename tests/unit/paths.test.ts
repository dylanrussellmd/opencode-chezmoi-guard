import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { canonical, expandPath, hostHome, pathKey } from "../../src/paths.js";

// Real filesystem: these branches are what a mocked realpath cannot exercise.
const root = realpathSync(mkdtempSync(join(tmpdir(), "chezmoi-guard-paths-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe("canonical", () => {
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "linked-dir"));
  symlinkSync(join(root, "real", "future"), join(root, "dangling"));
  symlinkSync("chain-b", join(root, "chain-a"));
  symlinkSync("chain-a", join(root, "chain-b"));

  it("resolves an existing symlinked directory", () => {
    expect(canonical(join(root, "linked-dir"))).toBe(join(root, "real"));
  });
  it("resolves a new file below a symlinked ancestor", () => {
    expect(canonical(join(root, "linked-dir", "new", "file"))).toBe(
      join(root, "real", "new", "file"),
    );
  });
  it("follows a dangling symlink to the referent it would create", () => {
    expect(canonical(join(root, "dangling"))).toBe(join(root, "real", "future"));
  });
  it("fails closed on a symlink loop", () => {
    expect(() => canonical(join(root, "chain-a"))).toThrow(/ELOOP/);
  });
  it("fails closed when the dangling-link chain revisits a path", () => {
    const path = join(root, "dangling");
    expect(() => canonical(path, new Set([path]))).toThrow("Cannot verify symlink chain");
  });
  it.skipIf(process.getuid?.() === 0)("rethrows non-ENOENT errors", () => {
    const locked = join(root, "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(() => canonical(join(locked, "inner", "file"))).toThrow(/EACCES/);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
  it("returns the root unchanged", () => {
    expect(canonical("/")).toBe("/");
  });
});

describe("expandPath", () => {
  it("mirrors the host's home, absolute and relative resolution", () => {
    expect(expandPath("~", "/cwd", "/h")).toBe("/h");
    expect(expandPath("~/a/../b", "/cwd", "/h")).toBe("/h/b");
    expect(expandPath("/abs/./x", "/cwd", "/h")).toBe("/abs/x");
    expect(expandPath("rel/x", "/cwd", "/h")).toBe("/cwd/rel/x");
    expect(expandPath("~user/x", "/cwd", "/h")).toBe("/cwd/~user/x");
  });
  it("uses OPENCODE_TEST_HOME before os.homedir(), like Global.Path.home", () => {
    expect(hostHome()).toBe(process.env.OPENCODE_TEST_HOME ?? homedir());
    vi.stubEnv("OPENCODE_TEST_HOME", "/test-home");
    expect(hostHome()).toBe("/test-home");
    expect(expandPath("~/x", "/cwd")).toBe("/test-home/x");
  });
});

describe("pathKey", () => {
  it("is exact on case-sensitive platforms", () => {
    expect(pathKey("/Home/.Bashrc", "linux")).toBe("/Home/.Bashrc");
  });
  it("folds case and Unicode form on macOS and Windows", () => {
    const nfd = "/Users/u/Cafe\u0301";
    expect(pathKey(nfd, "darwin")).toBe(pathKey("/users/U/CAF\u00c9", "darwin"));
    expect(pathKey("C:/Users/U", "win32")).toBe("c:/users/u");
  });
});
