import { describe, expect, it } from "vitest";
import { classifyKind } from "../../src/chezmoi.js";
import type { SourceKind } from "../../src/types.js";

const S = "/home/u/.local/share/chezmoi/";

describe("classifyKind — source-prefix routing", () => {
  const cases: [string, SourceKind][] = [
    ["dot_bashrc", "normal"],
    ["private_dot_ssh/config", "normal"],
    ["executable_dot_local_bin/script", "normal"],
    ["empty_dot_hushlogin", "normal"],
    ["dot_config/nvim/init.vim.tmpl", "template"],
    ["symlink_dot_vimrc", "symlink"],
    ["symlink_dot_vimrc.tmpl", "symlink"], // prefix wins over .tmpl
    ["modify_dot_bashrc", "modify"],
    ["modify_dot_bashrc.tmpl", "modify"], // prefix wins over .tmpl
    ["run_once_before_install.sh", "run"],
    ["run_onchange_setup.sh.tmpl", "run"],
    // exact_ is a directory attribute, not a file kind: a file *inside* an
    // exact_ dir is a normal editable file and must redirect, not skip.
    ["exact_dot_config/nvim/init.vim", "normal"],
    ["exact_dot_config/nvim/init.vim.tmpl", "template"],
    ["exact_dot_agents/agent-router/stacks/default.json", "normal"],
    ["encrypted_dot_netrc.age", "encrypted"], // prefix
    ["dot_secrets.asc", "encrypted"], // suffix only
    ["private_encrypted_dot_aws/credentials.age", "encrypted"], // most-restrictive wins
  ];

  for (const [name, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyKind(S + name)).toBe(expected);
    });
  }

  it("encrypts before run/modify/symlink/template", () => {
    expect(classifyKind(`${S}encrypted_run_once.sh`)).toBe("encrypted");
    expect(classifyKind(`${S}encrypted_modify_dot_bashrc`)).toBe("encrypted");
    expect(classifyKind(`${S}encrypted_symlink_dot_vimrc`)).toBe("encrypted");
    expect(classifyKind(`${S}encrypted_dot_config`)).toBe("encrypted");
  });

  // Regression: kind-prefixes are FILENAME attributes. An ancestor directory
  // carrying run_/modify_/symlink_/encrypted_/exact_ must NOT classify a
  // descendant file as that kind. The old `/(?:^|\/)prefix_/` whole-path
  // regex matched the dir boundary and misclassified (exact_→skip silently
  // breaking redirects; encrypted_→blocked edits wrongly; run_/modify_/
  // symlink_→wrong handling). Basename-only matching fixes all of them.
  describe("ancestor-directory prefixes do not leak into descendants", () => {
    const cases: [string, SourceKind][] = [
      ["exact_dot_agents/agent-router/stacks/default.json", "normal"],
      ["exact_dot_config/nvim/init.vim", "normal"],
      ["run_dot_tasks/somefile.txt", "normal"],
      ["modify_dot_bashrc_dir/extra.conf", "normal"],
      ["symlink_dot_things/real.txt", "normal"],
      ["encrypted_dot_ssh/config", "normal"], // dir encrypted_*, file plain → normal
      ["encrypted_dot_ssh/config.tmpl", "template"], // suffix still honored on the file
    ];
    for (const [name, expected] of cases) {
      it(`${name} → ${expected}`, () => {
        expect(classifyKind(S + name)).toBe(expected);
      });
    }
  });
});
