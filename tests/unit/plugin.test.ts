import type { Plugin } from "@opencode/plugin";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../../src/plugin.js";
import type { ResolveResult } from "../../src/types.js";

const mock = vi.hoisted(() => ({
  sources: new Map<string, ResolveResult>(),
  aliases: new Map<string, string>(),
  links: new Map<string, string>(),
  inventory: vi.fn(),
  chezmoi: vi.fn(),
}));
vi.mock("../../src/chezmoi.js", () => ({
  managedSources: mock.inventory,
  resolveSource: (path: string) => mock.sources.get(path) ?? null,
  readSymlinkTarget: (source: string) => mock.links.get(source) ?? null,
  chezmoi: mock.chezmoi,
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
  mock.sources.set(path, { sourcePath: `/source/${kind}`, kind, checkedAt: 0 });
}
beforeEach(() => {
  mock.sources.clear();
  mock.aliases.clear();
  mock.links.clear();
  mock.inventory.mockReset().mockImplementation(() => new Map(mock.sources));
  mock.chezmoi.mockReset();
});

describe("conservative V2 authorization boundary", () => {
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
        expect(mock.chezmoi).not.toHaveBeenCalled();
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
    expect(mock.chezmoi).not.toHaveBeenCalled();
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
    expect(mock.chezmoi).not.toHaveBeenCalled();
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
    mock.inventory.mockImplementation(() => {
      throw new Error("lookup failed");
    });
    await expect(h.before(event("write", { path: "/unmanaged" }))).rejects.toThrow("lookup failed");
    await expect(h.before(event("patch", { patchText: "*** Add File: /secret" }))).rejects.toThrow(
      "lookup failed",
    );
  });
  it("blocks whitespace-padded headers accepted by the real 2.0.8 patch parser", async () => {
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
  it("leaves unrelated tools and invalid inputs to host validation", async () => {
    const h = await harness();
    for (const e of [
      event("shell", {}),
      event("read", {}),
      event("edit", null),
      event("write", {}),
      event("patch", { patchText: 3 }),
    ])
      await h.before(e);
    expect(mock.inventory).not.toHaveBeenCalled();
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
});
