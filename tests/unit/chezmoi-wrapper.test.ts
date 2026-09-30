import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock-based unit tests for the chezmoi CLI wrappers.
 *
 * `run()` goes through `execFile`; the inventory canonicalises parents with
 * `realpathSync`; symlink definitions use `readFile`. Each test resets modules
 * so the advisory cache starts empty.
 */

type Exec = (cmd: string, args: string[], options: Record<string, unknown>) => string;
let execMock: Exec;
let readFileMock: (path: string) => string;
const aliases = new Map<string, string>();
const stdinEnd = vi.fn();

function failure(fields: Record<string, unknown>, stderr = ""): Error {
  return Object.assign(new Error(String(fields.message ?? "failed")), fields, { stderr });
}

beforeEach(() => {
  vi.resetModules();
  aliases.clear();
  stdinEnd.mockReset();
  vi.doMock("node:child_process", () => ({
    execFile: (
      cmd: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      queueMicrotask(() => {
        try {
          callback(null, execMock(cmd, args, options), "");
        } catch (error) {
          callback(error as Error, "", (error as { stderr?: string }).stderr ?? "");
        }
      });
      return { stdin: { end: stdinEnd } };
    },
  }));
  vi.doMock("node:fs", () => ({
    realpathSync: (path: string) => aliases.get(path) ?? path,
    lstatSync: () => ({ isSymbolicLink: () => false }),
    readlinkSync: () => "",
  }));
  vi.doMock("node:fs/promises", () => ({
    readFile: async (path: string) => readFileMock(path),
  }));
});

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.doUnmock("node:fs/promises");
  vi.restoreAllMocks();
});

async function load() {
  return await import("../../src/chezmoi.js");
}

const inventory = (entries: Record<string, [string, string]>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(entries).map(([key, [absolute, sourceAbsolute]]) => [
        key,
        { absolute, sourceAbsolute },
      ]),
    ),
  );

describe("run() subprocess wrapper", () => {
  it("passes --no-tty, bounds time and output, and closes stdin", async () => {
    let seen: { args: string[]; options: Record<string, unknown> } | undefined;
    execMock = (_cmd, args, options) => {
      seen = { args, options };
      return "  out  \n";
    };
    const m = await load();
    expect(await m.run(["--version"])).toEqual({ ok: true, stdout: "out" });
    expect(seen?.args).toEqual(["--no-tty", "--version"]);
    expect(seen?.options).toMatchObject({
      timeout: m.TIMEOUT_MS,
      maxBuffer: m.MAX_BUFFER,
      killSignal: "SIGKILL",
    });
    expect(m.MAX_BUFFER).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(stdinEnd).toHaveBeenCalledOnce();
  });

  for (const [name, error, stderr, reason] of [
    ["missing binary", { code: "ENOENT" }, "", "chezmoi not found on PATH"],
    [
      "output overflow",
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      "",
      "output exceeded 64 MiB",
    ],
    ["timeout", { killed: true, signal: "SIGKILL" }, "", "timed out after 15s"],
    [
      "exit status with stderr",
      { code: 1 },
      "chezmoi: bad config\nmore",
      "exit status 1: chezmoi: bad config",
    ],
    ["exit status without stderr", { code: 2 }, "", "exit status 2"],
    ["other error", { message: "spawn EACCES" }, "", "spawn EACCES"],
  ] as const) {
    it(`reports ${name} without throwing`, async () => {
      execMock = () => {
        throw failure(error, stderr);
      };
      const m = await load();
      expect(await m.run(["managed"])).toEqual({ ok: false, reason });
    });
  }
});

describe("mutation inventory (fail closed)", () => {
  it("distinguishes a successful empty inventory from subprocess failure", async () => {
    execMock = () => "{}";
    const m = await load();
    expect((await m.managedSources()).size).toBe(0);
    execMock = () => {
      throw failure({ code: 1 }, "configuration/decryption failure");
    };
    await expect(m.managedSources()).rejects.toThrow(
      "lookup failed (exit status 1: configuration/decryption failure)",
    );
  });
  it("names a timeout in the refusal", async () => {
    execMock = () => {
      throw failure({ killed: true });
    };
    const m = await load();
    await expect(m.managedSources()).rejects.toThrow("lookup failed (timed out after 15s)");
  });
  for (const output of [
    "",
    "broken json",
    "null",
    "[]",
    '{"x":{}}',
    '{"x":null}',
    '{"x":{"absolute":"relative","sourceAbsolute":"/source"}}',
    '{"x":{"absolute":"/target","sourceAbsolute":"relative"}}',
  ]) {
    it(`rejects invalid inventory ${output}`, async () => {
      execMock = () => output;
      const m = await load();
      await expect(m.managedSources()).rejects.toThrow("invalid chezmoi inventory");
    });
  }
  it("uses a fresh inventory for every mutation and classifies entries", async () => {
    let calls = 0;
    execMock = (_cmd, args) => {
      expect(args).toEqual([
        "--no-tty",
        "managed",
        "--include=files,symlinks",
        "--path-style=all",
        "--format=json",
      ]);
      return ++calls === 1
        ? "{}"
        : inventory({ ".secret": ["/target", "/source/encrypted_dot_secret.age"] });
    };
    const m = await load();
    expect((await m.managedSources()).get("/target")).toBeUndefined();
    expect((await m.managedSources()).get("/target")?.kind).toBe("encrypted");
  });
  it("keys entries by their parent-resolved path but never follows the final link", async () => {
    aliases.set("/home/u", "/var/home/u");
    aliases.set("/home/u/.link", "/home/u/dotfiles/link");
    execMock = () =>
      inventory({
        ".bashrc": ["/home/u/.bashrc", "/src/dot_bashrc"],
        ".link": ["/home/u/.link", "/src/symlink_dot_link"],
      });
    const m = await load();
    const sources = await m.managedSources();
    expect(m.lookup(sources, "/var/home/u/.bashrc")?.sourcePath).toBe("/src/dot_bashrc");
    expect(m.lookup(sources, "/var/home/u/.link")?.kind).toBe("symlink");
    expect(m.lookup(sources, "/home/u/dotfiles/link")).toBeUndefined();
  });
  it("finds a managed file through an alias of the full path", async () => {
    aliases.set("/elsewhere/alias", "/home/u/.bashrc");
    execMock = () => inventory({ ".bashrc": ["/home/u/.bashrc", "/src/dot_bashrc"] });
    const m = await load();
    expect(m.lookup(await m.managedSources(), "/elsewhere/alias")?.kind).toBe("normal");
  });
});

describe("advisory inventory (fail open)", () => {
  it("reuses a recent inventory, including one from a mutation", async () => {
    let calls = 0;
    execMock = () => {
      calls++;
      return inventory({ ".x": ["/t", "/s/dot_x.tmpl"] });
    };
    const m = await load();
    await m.managedSources();
    expect((await m.cachedSources())?.get("/t")?.kind).toBe("template");
    expect(calls).toBe(1);
    m.resetCache();
    await m.cachedSources();
    expect(calls).toBe(2);
  });
  it("returns null on failure and caches the failure briefly", async () => {
    let calls = 0;
    execMock = () => {
      calls++;
      throw failure({ code: "ENOENT" });
    };
    const m = await load();
    expect(await m.cachedSources()).toBeNull();
    expect(await m.cachedSources()).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("readSymlinkTarget", () => {
  it("renders templated symlink sources before resolving relative targets", async () => {
    execMock = (_cmd, args) => {
      expect(args).toEqual([
        "--no-tty",
        "execute-template",
        "--file",
        "--",
        "/src/symlink_dot_vimrc.tmpl",
      ]);
      return "../rendered/vimrc\n";
    };
    const m = await load();
    expect(await m.readSymlinkTarget("/src/symlink_dot_vimrc.tmpl", "/home/u/.vimrc")).toBe(
      "/home/rendered/vimrc",
    );
  });
  it("returns null when a templated definition fails to render", async () => {
    execMock = () => {
      throw failure({ code: 1 });
    };
    const m = await load();
    expect(await m.readSymlinkTarget("/src/symlink_dot_vimrc.tmpl", "/home/u/.vimrc")).toBeNull();
  });
  it("resolves a relative link target against the symlink's own directory", async () => {
    readFileMock = () => "../dotfiles/vimrc\n";
    const m = await load();
    expect(await m.readSymlinkTarget("/src/symlink_dot_vimrc", "/home/u/.vimrc")).toBe(
      "/home/dotfiles/vimrc",
    );
  });
  it("resolves an absolute link target as-is", async () => {
    readFileMock = () => "/opt/dotfiles/vimrc";
    const m = await load();
    expect(await m.readSymlinkTarget("/src/symlink_dot_vimrc", "/home/u/.vimrc")).toBe(
      "/opt/dotfiles/vimrc",
    );
  });
  it("returns null when the source cannot be read or is empty", async () => {
    const m = await load();
    readFileMock = () => {
      throw new Error("ENOENT");
    };
    expect(await m.readSymlinkTarget("/src/missing", "/home/u/.vimrc")).toBeNull();
    readFileMock = () => "   \n";
    expect(await m.readSymlinkTarget("/src/symlink_dot_vimrc", "/home/u/.vimrc")).toBeNull();
  });
});
