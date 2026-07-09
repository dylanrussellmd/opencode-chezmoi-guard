import { describe, expect, it } from "vitest";
import {
  buildEncryptedGuidance,
  buildModifyGuidance,
  buildReadGuidance,
  buildSymlinkGuidance,
  buildTemplateGuidance,
  kindLabel,
  levelToVariant,
} from "../../src/guidance.js";
import type { SourceKind } from "../../src/types.js";

describe("levelToVariant", () => {
  it("maps error → error", () => {
    expect(levelToVariant("error")).toBe("error");
  });
  it("maps warn → warning", () => {
    expect(levelToVariant("warn")).toBe("warning");
  });
  it("maps info → info", () => {
    expect(levelToVariant("info")).toBe("info");
  });
});

describe("kindLabel", () => {
  const kinds: SourceKind[] = [
    "run",
    "modify",
    "symlink",
    "exact",
    "encrypted",
    "template",
    "normal",
  ];
  for (const k of kinds) {
    it(`returns ${k} unchanged`, () => {
      expect(kindLabel(k)).toBe(k);
    });
  }
});

describe("buildEncryptedGuidance", () => {
  it("mentions the target, source, and chezmoi edit recommendation", () => {
    const g = buildEncryptedGuidance("/home/u/.netrc", "/src/encrypted_dot_netrc.age");
    expect(g).toContain("/home/u/.netrc");
    expect(g).toContain("/src/encrypted_dot_netrc.age");
    expect(g).toContain("EDIT BLOCKED");
    expect(g).toContain("chezmoi edit /home/u/.netrc");
    expect(g).toContain("RECOMMENDATION");
  });
});

describe("buildModifyGuidance", () => {
  it("mentions the modify_ script and persistence risk", () => {
    const g = buildModifyGuidance("/home/u/.bashrc", "/src/modify_dot_bashrc");
    expect(g).toContain("MODIFY SCRIPT");
    expect(g).toContain("/src/modify_dot_bashrc");
    expect(g).toContain("overwritten");
    expect(g).toContain("cat /src/modify_dot_bashrc");
  });
});

describe("buildSymlinkGuidance", () => {
  it("shows symlink, source, and actual file", () => {
    const g = buildSymlinkGuidance(
      "/home/u/.vimrc",
      "/src/symlink_dot_vimrc",
      "/home/u/dotfiles/vimrc",
    );
    expect(g).toContain("Target (symlink):   /home/u/.vimrc");
    expect(g).toContain("Source:             /src/symlink_dot_vimrc");
    expect(g).toContain("Actual file:        /home/u/dotfiles/vimrc");
    expect(g).toContain("recreate the symlink");
  });
});

describe("buildTemplateGuidance", () => {
  it("write: warns the write hit the rendered target", () => {
    const g = buildTemplateGuidance("/home/u/.bashrc", "/src/dot_bashrc.tmpl", "write");
    expect(g).toContain("WRITE OPERATION");
    expect(g).toContain("WILL be overwritten");
    expect(g).toContain("Cancel this write");
    expect(g).toContain("/src/dot_bashrc.tmpl");
  });

  it("edit: notes it is editing the template source", () => {
    const g = buildTemplateGuidance("/home/u/.bashrc", "/src/dot_bashrc.tmpl", "edit");
    expect(g).toContain("EDIT OPERATION");
    expect(g).toContain("Go template syntax");
    expect(g).toContain("Edit carefully");
  });

  it("both include chezmoi data / cat hints", () => {
    for (const t of ["edit", "write"] as const) {
      const g = buildTemplateGuidance("/home/u/.bashrc", "/src/dot_bashrc.tmpl", t);
      expect(g).toContain("chezmoi data");
      expect(g).toContain("chezmoi cat /home/u/.bashrc");
    }
  });
});

describe("buildReadGuidance", () => {
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
