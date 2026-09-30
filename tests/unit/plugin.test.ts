import { homedir } from "node:os";
import type { Plugin } from "@opencode/plugin";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../src/plugin.js";
import type { ResolveResult } from "../../src/types.js";

const mock = vi.hoisted(() => ({
  sources: new Map<string, ResolveResult>(),
  aliases: new Map<string, string>(),
  links: new Map<string, string>(),
  inventory: vi.fn(),
  cached: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../../src/chezmoi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chezmoi.js")>()),
  managedSources: mock.inventory,
  cachedSources: mock.cached,
  readSymlinkTarget: async (source: string) => mock.links.get(source) ?? null,
  run: mock.run,
}));
vi.mock("node:fs", () => ({ realpathSync: (path: string) => mock.aliases.get(path) ?? path }));

type Hook = Parameters<Plugin.Context["tool"]["hook"]>[1];
function event(tool: string, input: unknown) {
  return { tool, input, id: "call", sessionID: "session", agent: "build", messageID: "message" };
}
async function harness() {
  const hooks = new Map<string, Hook>();
  const permission = { hook: vi.fn(), reply: vi.fn() };
  await plugin.setup({
    location: { directory: "/wrong" },
    session: { get: async () => ({ location: { directory: "/session" } }) },
    permission,
    tool: {
      hook: async (name: string, callback: Hook) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
  } as unknown as Plugin.Context);
  return {
    hooks,
    permission,
    before: async (e: ReturnType<typeof event>) => {
      await hooks.get("execute.before")?.(e as never);
      return e;
    },
    after: async (
      e: ReturnType<typeof event>,
      content: unknown = "ORIGINAL",
      status = "completed",
    ) => {
      const output = {
        ...e,
        status,
        result: { content, output: { kept: true }, metadata: { title: "kept" } },
        error: { message: "failed" },
      };
      await hooks.get("execute.after")?.(output as never);
      return output;
    },
  };
}
function managed(kind: ResolveResult["kind"] = "normal", path = "/target") {
  mock.sources.set(path, { sourcePath: `/source/${kind}`, kind });
}
beforeEach(() => {
  mock.sources.clear();
  mock.aliases.clear();
  mock.links.clear();
  mock.inventory.mockReset().mockImplementation(async () => new Map(mock.sources));
  mock.cached.mockReset().mockImplementation(async () => new Map(mock.sources));
  mock.run.mockReset();
});

describe("conservative V2 authorization boundary", () => {
  for (const tool of ["edit", "write"]) {
    for (const path of ["~", "~/managed"]) {
      it(`expands home paths before ${tool} protection: ${path}`, async () => {
        managed("normal", path === "~" ? homedir() : `${homedir()}/managed`);
        const h = await harness();
        await expect(h.before(event(tool, { path }))).rejects.toThrow(
          "Managed target mutation blocked",
        );
      });
    }
  }
  for (const tool of ["patch", "apply_patch"]) {
    for (const header of ["Add File", "Update File", "Delete File", "Move to"]) {
      it(`expands home paths in ${tool} ${header}`, async () => {
        managed("normal", `${homedir()}/managed`);
        const h = await harness();
        await expect(
          h.before(
            event(tool, {
              patchText: `*** Begin Patch\n*** Update File: /unmanaged\n@@\n-old\n+new\n*** ${header}: ~/managed\n*** End Patch`,
            }),
          ),
        ).rejects.toThrow("Managed target mutation blocked");
      });
    }
  }
  for (const kind of ["normal", "template", "modify", "symlink", "encrypted", "run"] as const) {
    for (const tool of ["edit", "write"]) {
      it(`blocks managed ${kind} ${tool} before any input rewrite`, async () => {
        managed(kind);
        const h = await harness();
        const e = event(tool, { path: "/target", content: "new", oldString: "old" });
        const original = structuredClone(e.input);
        await expect(h.before(e)).rejects.toThrow(
          kind === "encrypted" ? "EDIT BLOCKED" : "Managed target mutation blocked",
        );
        expect(e.input).toEqual(original);
        expect(mock.run).not.toHaveBeenCalled();
      });
    }
  }
  for (const tool of ["patch", "apply_patch"]) {
    for (const header of ["Add File", "Update File", "Delete File", "Move to"]) {
      it(`blocks ${tool} managed ${header} atomically`, async () => {
        managed();
        const h = await harness();
        const e = event(tool, {
          patchText: `*** Begin Patch\n*** Update File: /unmanaged\n@@\n-old\n+new\n*** ${header}: /target\n*** End Patch`,
        });
        const original = structuredClone(e.input);
        await expect(h.before(e)).rejects.toThrow("Managed target mutation blocked");
        expect(e.input).toEqual(original);
      });
    }
  }
  it("blocks a source-allowed/target-denied request without reaching execution (simulated host ordering)", async () => {
    managed();
    const h = await harness();
    const execute = vi.fn();
    const rules = new Map([
      ["/source/normal", "allow"],
      ["/target", "deny"],
    ]);
    const run = async (e: ReturnType<typeof event>) => {
      await h.before(e);
      const path = (e.input as { path: string }).path;
      if (rules.get(path) !== "allow") throw new Error("host permission denied");
      execute(path);
      await h.after(e);
    };
    await expect(run(event("edit", { path: "/target" }))).rejects.toThrow(
      "Managed target mutation blocked",
    );
    expect(execute).not.toHaveBeenCalled();
    await run(event("edit", { path: "/source/normal" }));
    expect(execute).toHaveBeenCalledExactlyOnceWith("/source/normal");
    expect(mock.run).not.toHaveBeenCalled();
    rules.set("/source/normal", "deny");
    await expect(run(event("edit", { path: "/source/normal" }))).rejects.toThrow(
      "host permission denied",
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("never applies, even on a completed event for a blocked request or an explicit source edit", async () => {
    const h = await harness();
    for (const path of ["/target", "/source/normal"]) {
      expect((await h.after(event("write", { path }))).result.content).toBe("ORIGINAL");
    }
    expect(mock.run).not.toHaveBeenCalled();
    expect(h.permission.hook).not.toHaveBeenCalled();
    expect(h.permission.reply).not.toHaveBeenCalled();
  });
  it("blocks aliases and managed symlink paths, including relative filePath", async () => {
    managed();
    managed("symlink", "/session/link");
    mock.aliases.set("/alias", "/target");
    const h = await harness();
    await expect(h.before(event("edit", { path: "/alias" }))).rejects.toThrow(
      "Managed target mutation blocked",
    );
    await expect(h.before(event("write", { filePath: "link" }))).rejects.toThrow(
      "Managed target mutation blocked",
    );
  });
  it("fails closed on inventory errors, never reusing an earlier unmanaged result", async () => {
    const h = await harness();
    await h.before(event("write", { path: "/unmanaged" }));
    mock.inventory.mockRejectedValue(new Error("lookup failed"));
    await expect(h.before(event("write", { path: "/unmanaged" }))).rejects.toThrow("lookup failed");
    await expect(h.before(event("patch", { patchText: "*** Add File: /secret" }))).rejects.toThrow(
      "lookup failed",
    );
  });
  it("blocks whitespace-padded headers accepted by the real host patch parser", async () => {
    managed();
    const h = await harness();
    await expect(
      h.before(
        event("patch", {
          patchText: "*** Begin Patch\n  *** Add File: /target  \n+new\n*** End Patch",
        }),
      ),
    ).rejects.toThrow("Managed target mutation blocked");
  });
  it("leaves unmanaged operations and source input intact for host permission checking", async () => {
    const h = await harness();
    for (const e of [
      event("edit", { path: "/unmanaged" }),
      event("write", { path: "/source/normal" }),
      event("patch", {
        patchText: "*** Delete File: /old\n*** Update File: /one\n*** Move to: /two",
      }),
    ]) {
      const original = structuredClone(e.input);
      await h.before(e);
      expect(e.input).toEqual(original);
    }
  });
  it("leaves unrelated tools to the host without an inventory lookup", async () => {
    const h = await harness();
    for (const e of [event("shell", {}), event("read", {}), event("grep", null)]) await h.before(e);
    expect(mock.inventory).not.toHaveBeenCalled();
  });
  for (const [tool, input] of [
    ["edit", null],
    ["edit", "~/.bashrc"],
    ["write", {}],
    ["write", { path: "" }],
    ["edit", { file_path: "~/.bashrc" }],
    ["edit", { edits: [{ path: "~/.bashrc" }] }],
    ["patch", { patchText: 3 }],
    ["patch", { patch: "*** Begin Patch\n*** Add File: ~/.bashrc\n*** End Patch" }],
    ["patch", { patchText: "*** Begin Patch\n*** End Patch" }],
    ["apply_patch", { patchText: "*** Begin Patch\n***Add File: /x\n*** End Patch" }],
  ] as const) {
    it(`fails closed on uninterpretable ${tool} input ${JSON.stringify(input)}`, async () => {
      const h = await harness();
      await expect(h.before(event(tool, input))).rejects.toThrow(
        `Cannot determine the target path of this ${tool} call`,
      );
      expect(mock.inventory).not.toHaveBeenCalled();
    });
  }
  it("expands ~ against OPENCODE_TEST_HOME like the host", async () => {
    vi.stubEnv("OPENCODE_TEST_HOME", "/test-home");
    try {
      managed("normal", "/test-home/managed");
      const h = await harness();
      await expect(h.before(event("write", { path: "~/managed" }))).rejects.toThrow(
        "Managed target mutation blocked",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("blocks a target below a symlinked parent directory", async () => {
    managed("normal", "/home/u/.bashrc");
    mock.aliases.set("/var/home/u", "/home/u");
    const h = await harness();
    await expect(h.before(event("edit", { path: "/var/home/u/.bashrc" }))).rejects.toThrow(
      "Managed target mutation blocked",
    );
  });
});

describe("read advisories (mocked hook context)", () => {
  for (const [kind, label] of [
    ["template", "READING RENDERED OUTPUT"],
    ["modify", "MODIFY SCRIPT"],
    ["encrypted", "EDITS ARE BLOCKED"],
  ] as const) {
    it(`advises ${kind} without a mutation or inventory gate`, async () => {
      managed(kind);
      const h = await harness();
      const e = event("read", { path: "/target" });
      await h.before(e);
      const result = (await h.after(e)).result;
      expect(result.content).toContain(label);
      expect(result.content).toContain("ORIGINAL");
      expect(result.output).toEqual({ kept: true });
      expect(mock.inventory).not.toHaveBeenCalled();
    });
  }
  it("preserves structured content through a linked template advisory", async () => {
    managed("template");
    managed("symlink", "/link");
    mock.links.set("/source/symlink", "/target");
    const h = await harness();
    const content = [{ type: "file", uri: "file:///image.png", mime: "image/png" }];
    expect(
      (
        (await h.after(event("read", { path: "/link" }), content)).result.content as unknown[]
      ).slice(1),
    ).toEqual(content);
  });
  it("leaves failed and ordinary reads unchanged", async () => {
    managed();
    const h = await harness();
    for (const input of [{ path: "/target" }, { path: "/unmanaged" }, {}, null])
      expect((await h.after(event("read", input))).result.content).toBe("ORIGINAL");
    expect(
      (await h.after(event("read", { path: "/target" }), "ORIGINAL", "error")).result.content,
    ).toBe("ORIGINAL");
  });
  it("fails open when the advisory inventory or path resolution is unavailable", async () => {
    managed("template");
    const h = await harness();
    mock.cached.mockResolvedValueOnce(null);
    expect((await h.after(event("read", { path: "/target" }))).result.content).toBe("ORIGINAL");
    mock.cached.mockRejectedValueOnce(new Error("boom"));
    expect((await h.after(event("read", { path: "/target" }))).result.content).toBe("ORIGINAL");
  });
  it("advises through an alias of a template target", async () => {
    managed("template");
    mock.aliases.set("/alias", "/target");
    const h = await harness();
    expect((await h.after(event("read", { path: "/alias" }))).result.content).toContain(
      "READING RENDERED OUTPUT",
    );
  });
  it("stops on a symlink cycle without an advisory", async () => {
    managed("symlink", "/a");
    mock.sources.set("/b", { sourcePath: "/source/b", kind: "symlink" });
    mock.links.set("/source/symlink", "/b");
    mock.links.set("/source/b", "/a");
    const h = await harness();
    expect((await h.after(event("read", { path: "/a" }))).result.content).toBe("ORIGINAL");
  });
});
