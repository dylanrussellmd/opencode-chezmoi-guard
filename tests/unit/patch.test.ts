import { describe, expect, it } from "vitest";
import { extractPathsFromPatch } from "../../src/patch.js";

describe("extractPathsFromPatch — opcode + unified-diff headers", () => {
  it("extracts *** Update File marker", () => {
    const p = "*** Update File: /home/u/.bashrc\n@@ -1 +1 @@";
    expect(extractPathsFromPatch(p)[0]).toBe("/home/u/.bashrc");
  });

  it("extracts *** Create File marker", () => {
    const p = "*** Create File: /home/u/.newrc\n@@ -0,0 +1 @@";
    expect(extractPathsFromPatch(p).includes("/home/u/.newrc")).toBe(true);
  });

  it("extracts unified --- / +++ with a//b/ prefixes", () => {
    const p = "--- a/home/u/.gitconfig\n+++ b/home/u/.gitconfig";
    expect(extractPathsFromPatch(p).includes("home/u/.gitconfig")).toBe(true);
  });

  it("excludes /dev/null", () => {
    const p = "--- /dev/null\n+++ b/home/u/.created";
    const paths = extractPathsFromPatch(p);
    expect(paths.includes("/dev/null")).toBe(false);
    expect(paths.includes("home/u/.created")).toBe(true);
  });

  it("multi-file patch yields all unique paths", () => {
    const p = "*** Update File: /home/u/.bashrc\n*** Update File: /home/u/.config/git/config";
    expect(extractPathsFromPatch(p).length).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates the same path appearing in --- and +++", () => {
    const p = "--- a/home/u/.gitconfig\n+++ b/home/u/.gitconfig";
    const paths = extractPathsFromPatch(p);
    expect(paths.filter((x) => x === "home/u/.gitconfig").length).toBe(1);
  });
});
