import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolveResult } from "../../src/types.js";

/**
 * Hook-level tests for the read advisory. The chezmoi module is mocked so
 * `resolveSource` is controllable per case; the plugin is then instantiated
 * with a stub client and its `tool.execute.after` hook driven directly.
 *
 * The advisory contract under test:
 *   - read of a template/modify/encrypted target → guidance PREPENDED,
 *     original tool output preserved, args untouched, no pending state.
 *   - read of a normal/symlink/run/exact or unmanaged path → output untouched.
 *   - missing filePath / missing output → no-op, never throws.
 */

let resolveResult: ResolveResult | null = null;
const resolveCalls: string[] = [];

beforeEach(() => {
  resolveResult = null;
  resolveCalls.length = 0;
  vi.resetModules();
  vi.doMock("../../src/chezmoi.js", () => ({
    _log: () => {},
    chezmoi: () => null,
    chezmoiInstalled: () => true,
    readSymlinkTarget: () => null,
    resolveSource: (p: string) => {
      resolveCalls.push(p);
      return resolveResult;
    },
  }));
});

afterEach(() => {
  vi.doUnmock("../../src/chezmoi.js");
  vi.restoreAllMocks();
});

/** Instantiate the plugin against a stub client and return its hooks. */
async function loadHooks() {
  const { ChezmoiGuardPlugin } = await import("../../src/plugin.js");
  // Minimal ctx: only `client` is touched, and every client call is optional.
  return await ChezmoiGuardPlugin({ client: {} } as never);
}

function readInput(filePath?: string) {
  return {
    tool: "read",
    sessionID: "s1",
    callID: "c1",
    args: filePath === undefined ? {} : { filePath },
  } as never;
}

function freshOutput(content = "1: line one\n2: line two\n") {
  return { title: "read", output: content, metadata: {} };
}

function resolved(kind: ResolveResult["kind"], sourcePath: string): ResolveResult {
  return { sourcePath, kind, checkedAt: Date.now() };
}

describe("read advisory (tool.execute.after)", () => {
  it("prepends template guidance and preserves the original output", async () => {
    resolveResult = resolved("template", "/src/dot_bashrc.tmpl");
    const hooks = await loadHooks();
    const out = freshOutput("RAW-CONTENT");

    await hooks["tool.execute.after"]?.(readInput("/home/u/.bashrc"), out as never);

    expect(out.output).toContain("READING RENDERED OUTPUT");
    expect(out.output).toContain("/src/dot_bashrc.tmpl");
    expect(out.output.endsWith("RAW-CONTENT")).toBe(true);
  });

  it("prepends modify guidance for modify_ sources", async () => {
    resolveResult = resolved("modify", "/src/modify_dot_bashrc");
    const hooks = await loadHooks();
    const out = freshOutput("RAW-CONTENT");

    await hooks["tool.execute.after"]?.(readInput("/home/u/.bashrc"), out as never);

    expect(out.output).toContain("MODIFY SCRIPT");
    expect(out.output).toContain("/src/modify_dot_bashrc");
    expect(out.output.endsWith("RAW-CONTENT")).toBe(true);
  });

  it("prepends encrypted guidance for encrypted sources", async () => {
    resolveResult = resolved("encrypted", "/src/encrypted_dot_netrc.age");
    const hooks = await loadHooks();
    const out = freshOutput("RAW-CONTENT");

    await hooks["tool.execute.after"]?.(readInput("/home/u/.netrc"), out as never);

    expect(out.output).toContain("EDITS ARE BLOCKED");
    expect(out.output).toContain("chezmoi edit /home/u/.netrc");
    expect(out.output.endsWith("RAW-CONTENT")).toBe(true);
  });

  for (const kind of ["normal", "symlink", "run", "exact"] as const) {
    it(`stays silent for ${kind} sources`, async () => {
      resolveResult = resolved(kind, `/src/${kind}_thing`);
      const hooks = await loadHooks();
      const out = freshOutput("RAW-CONTENT");

      await hooks["tool.execute.after"]?.(readInput("/home/u/.thing"), out as never);

      expect(out.output).toBe("RAW-CONTENT");
    });
  }

  it("stays silent for unmanaged paths", async () => {
    resolveResult = null;
    const hooks = await loadHooks();
    const out = freshOutput("RAW-CONTENT");

    await hooks["tool.execute.after"]?.(readInput("/tmp/scratch.txt"), out as never);

    expect(out.output).toBe("RAW-CONTENT");
    expect(resolveCalls).toEqual(["/tmp/scratch.txt"]);
  });

  it("no-ops when args carry no filePath", async () => {
    resolveResult = resolved("template", "/src/dot_x.tmpl");
    const hooks = await loadHooks();
    const out = freshOutput("RAW-CONTENT");

    await hooks["tool.execute.after"]?.(readInput(undefined), out as never);

    expect(out.output).toBe("RAW-CONTENT");
    expect(resolveCalls).toEqual([]); // never consulted chezmoi
  });

  it("no-ops (without throwing) when output is undefined", async () => {
    resolveResult = resolved("template", "/src/dot_x.tmpl");
    const hooks = await loadHooks();

    await expect(
      hooks["tool.execute.after"]?.(readInput("/home/u/.bashrc"), undefined as never),
    ).resolves.toBeUndefined();
    expect(resolveCalls).toEqual([]); // bailed before resolving
  });

  it("never rewrites read args in the before-hook", async () => {
    resolveResult = resolved("template", "/src/dot_bashrc.tmpl");
    const hooks = await loadHooks();
    const before = { args: { filePath: "/home/u/.bashrc" } };

    await hooks["tool.execute.before"]?.(
      { tool: "read", sessionID: "s1", callID: "c1" } as never,
      before as never,
    );

    expect(before.args.filePath).toBe("/home/u/.bashrc");
    expect(resolveCalls).toEqual([]); // read is not an intercepted tool
  });

  it("relative read paths are resolved before consulting chezmoi", async () => {
    resolveResult = null;
    const hooks = await loadHooks();
    const out = freshOutput("RAW-CONTENT");

    await hooks["tool.execute.after"]?.(readInput("some/rel/path.txt"), out as never);

    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]?.startsWith("/")).toBe(true);
    expect(resolveCalls[0]?.endsWith("/some/rel/path.txt")).toBe(true);
  });
});
