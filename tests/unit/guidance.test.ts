import { describe, expect, it } from "vitest";
import { buildEncryptedGuidance, buildReadGuidance } from "../../src/guidance.js";

describe("buildEncryptedGuidance", () => {
  it("mentions the target, source, and chezmoi edit recommendation", () => {
    const g = buildEncryptedGuidance("/home/u/.netrc", "/src/encrypted_dot_netrc.age");
    expect(g).toContain("/home/u/.netrc");
    expect(g).toContain("/src/encrypted_dot_netrc.age");
    expect(g).toContain("EDIT BLOCKED");
    expect(g).toContain("chezmoi edit /home/u/.netrc");
    expect(g).toContain("RECOMMENDATION");
    expect(g).toContain("blocked before execution");
    expect(g).not.toContain("redirect");
  });
});

describe("buildReadGuidance", () => {
  it("never describes redirection or automatic apply as active", () => {
    for (const kind of ["template", "modify", "encrypted"] as const) {
      expect(buildReadGuidance("/t", "/s", kind)).not.toMatch(/redirected|will sync/i);
    }
  });

  it("template: warns rendered bytes differ and points at the source", () => {
    const g = buildReadGuidance("/home/u/.bashrc", "/src/dot_bashrc.tmpl", "template");
    expect(g).toContain("READING RENDERED OUTPUT");
    expect(g).toContain("Target (rendered):  /home/u/.bashrc");
    expect(g).toContain("Source (template):  /src/dot_bashrc.tmpl");
    expect(g).toContain("READ THE SOURCE FIRST");
    expect(g).toContain("oldString");
    expect(g).toContain(
      "RECOMMENDATION: Before editing, read the source template: /src/dot_bashrc.tmpl",
    );
  });

  it("modify: explains script-managed state and persistence risk", () => {
    const g = buildReadGuidance("/home/u/.bashrc", "/src/modify_dot_bashrc", "modify");
    expect(g).toContain("MODIFY SCRIPT");
    expect(g).toContain("Source (modify script): /src/modify_dot_bashrc");
    expect(g).toContain("overwritten");
    expect(g).toContain("RECOMMENDATION: Read the modify script before planning an edit");
  });

  it("encrypted: says reads are fine but edits are blocked, recommends chezmoi edit", () => {
    const g = buildReadGuidance("/home/u/.netrc", "/src/encrypted_dot_netrc.age", "encrypted");
    expect(g).toContain("EDITS ARE BLOCKED");
    expect(g).toContain("Source (ciphertext):         /src/encrypted_dot_netrc.age");
    expect(g).toContain("chezmoi edit /home/u/.netrc");
    expect(g).toContain("RECOMMENDATION: Do not plan a direct edit/write");
  });
});
