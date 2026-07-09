import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock-based unit tests for the chezmoi CLI wrappers.
 *
 * The wrappers (`chezmoi`, `chezmoiInstalled`, `resolveSource`,
 * `readSymlinkTarget`) hold module-level state (`chezmoiAvailable`, the
 * resolve cache). Each test resets modules + re-mocks `execFileSync` /
 * `readFileSync` so the state starts fresh and the spy can be reconfigured
 * per case.
 */

// Stash the mock impls so each test can set them before importing.
let execMock: (cmd: string, args: string[]) => string;
let readFileSyncMock: (path: string, enc: string) => string;

beforeEach(() => {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (cmd: string, args: string[]) => execMock(cmd, args),
  }));
  vi.doMock("node:fs", () => ({
    readFileSync: (path: string, enc: string) => readFileSyncMock(path, enc),
  }));
});

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.restoreAllMocks();
});

/** Dynamic import so the doMock above takes effect before module init. */
async function load() {
  return await import("../../src/chezmoi.js");
}

describe("chezmoi() subprocess wrapper", () => {
  it("returns trimmed stdout on success and marks the binary available", async () => {
    execMock = () => "  chezmoi version 2.58.0  \n";
    const m = await load();
    expect(m.chezmoi(["--version"])).toBe("chezmoi version 2.58.0");
    expect(m.chezmoiInstalled()).toBe(true);
  });

  it("returns null and remembers ENOENT (binary missing) for the session", async () => {
    execMock = () => {
      const e = new Error("spawn ENOENT");
      (e as Error & { code: string }).code = "ENOENT";
      throw e;
    };
    const m = await load();
    expect(m.chezmoi(["--version"])).toBeNull();
    // cached as unavailable — subsequent calls short-circuit without exec
    expect(m.chezmoiInstalled()).toBe(false);
  });

  it("returns null on a non-ENOENT failure (e.g. nonzero exit) without marking the binary missing", async () => {
    let call = 0;
    execMock = () => {
      call++;
      if (call === 1) {
        const e = new Error("exit code 1");
        (e as Error & { code: string }).code = "1";
        throw e;
      }
      return "chezmoi version 2.58.0";
    };
    const m = await load();
    expect(m.chezmoi(["managed", "--path-style=source-absolute", "/x"])).toBeNull();
    // a later successful call still works (binary not blacklisted)
    expect(m.chezmoi(["--version"])).toBe("chezmoi version 2.58.0");
    expect(m.chezmoiInstalled()).toBe(true);
  });
});

describe("resolveSource", () => {
  it("returns null when chezmoi is not installed", async () => {
    execMock = () => {
      const e = new Error("spawn ENOENT");
      (e as Error & { code: string }).code = "ENOENT";
      throw e;
    };
    const m = await load();
    expect(m.resolveSource("/home/u/.bashrc")).toBeNull();
  });

  it("resolves a managed file to its source path and classifies the kind", async () => {
    let call = 0;
    execMock = (_cmd, args) => {
      call++;
      if (args[0] === "--version") return "chezmoi version 2.58.0";
      if (args[0] === "managed") return "/home/u/.local/share/chezmoi/dot_bashrc";
      throw new Error(`unexpected call #${call}: ${args.join(" ")}`);
    };
    const m = await load();
    const r = m.resolveSource("/home/u/.bashrc");
    expect(r).not.toBeNull();
    expect(r?.sourcePath).toBe("/home/u/.local/share/chezmoi/dot_bashrc");
    expect(r?.kind).toBe("normal");
  });

  it("classifies a .tmpl source as template", async () => {
    execMock = (_cmd, args) =>
      args[0] === "--version"
        ? "chezmoi version 2.58.0"
        : "/home/u/.local/share/chezmoi/dot_config/nvim/init.vim.tmpl";
    const m = await load();
    expect(m.resolveSource("/home/u/.config/nvim/init.vim")?.kind).toBe("template");
  });

  it("returns null for an unmanaged target", async () => {
    execMock = (_cmd, args) => (args[0] === "--version" ? "chezmoi version 2.58.0" : "");
    const m = await load();
    expect(m.resolveSource("/home/u/.notmanaged")).toBeNull();
  });

  it("serves a cached result on the second call within the TTL", async () => {
    let managedCalls = 0;
    execMock = (_cmd, args) => {
      if (args[0] === "--version") return "chezmoi version 2.58.0";
      if (args[0] === "managed") {
        managedCalls++;
        return "/src/dot_bashrc";
      }
      throw new Error("unexpected");
    };
    const m = await load();
    m.resolveSource("/home/u/.bashrc");
    m.resolveSource("/home/u/.bashrc");
    expect(managedCalls).toBe(1); // second call hit the cache
  });
});

describe("readSymlinkTarget", () => {
  it("resolves a relative link target against the symlink's own directory", async () => {
    readFileSyncMock = () => "../dotfiles/vimrc\n";
    const m = await load();
    const actual = m.readSymlinkTarget("/src/symlink_dot_vimrc", "/home/u/.vimrc");
    expect(actual).toBe("/home/dotfiles/vimrc");
  });

  it("resolves an absolute link target as-is", async () => {
    readFileSyncMock = () => "/opt/dotfiles/vimrc";
    const m = await load();
    expect(m.readSymlinkTarget("/src/symlink_dot_vimrc", "/home/u/.vimrc")).toBe(
      "/opt/dotfiles/vimrc",
    );
  });

  it("returns null when the source file cannot be read", async () => {
    readFileSyncMock = () => {
      throw new Error("ENOENT");
    };
    const m = await load();
    expect(m.readSymlinkTarget("/src/missing", "/home/u/.vimrc")).toBeNull();
  });

  it("returns null for an empty link target", async () => {
    readFileSyncMock = () => "   \n";
    const m = await load();
    expect(m.readSymlinkTarget("/src/symlink_dot_vimrc", "/home/u/.vimrc")).toBeNull();
  });
});

describe("classifyKind", () => {
  it("is re-exported and still routes by prefix", async () => {
    execMock = () => "chezmoi version 2.58.0";
    const m = await load();
    expect(m.classifyKind("/src/dot_bashrc")).toBe("normal");
    expect(m.classifyKind("/src/encrypted_dot_netrc.age")).toBe("encrypted");
  });
});
