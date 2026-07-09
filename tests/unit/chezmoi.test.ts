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
    ["exact_dot_config/nvim", "exact"],
    ["encrypted_dot_netrc.age", "encrypted"], // prefix
    ["dot_secrets.asc", "encrypted"], // suffix only
    ["private_encrypted_dot_aws/credentials.age", "encrypted"], // most-restrictive wins
  ];

  for (const [name, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyKind(S + name)).toBe(expected);
    });
  }

  it("encrypts before run/modify/symlink/exact/template", () => {
    expect(classifyKind(`${S}encrypted_run_once.sh`)).toBe("encrypted");
    expect(classifyKind(`${S}encrypted_modify_dot_bashrc`)).toBe("encrypted");
    expect(classifyKind(`${S}encrypted_symlink_dot_vimrc`)).toBe("encrypted");
    expect(classifyKind(`${S}encrypted_exact_dot_config`)).toBe("encrypted");
  });
});
