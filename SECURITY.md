# OpenCode authorization audit

Audited host releases: **2.0.8** and **2.0.19**. The `peerDependencies` range (`2.0.8 || 2.0.19`) and `AUDITED` in `scripts/native-tui-smoke.py` list exactly these; widen them only after repeating the audit below for the new release.

## Finding and remedy

The initial V2 port had a permission bypass: the before-hook changed the target to its source before native permission checks, then the after-hook wrote the original target through a subprocess. An allowed source did not authorize a denied target.

The revised guard does not attempt to infer authorization from session configuration, pending requests, or a previously observed permission event. It blocks managed target mutations before execution, never changes tool input, and never runs apply. Explicit source edits remain ordinary host-authorized operations; they do not synchronize targets automatically. All managed source kinds and patch headers use this boundary, including symlink paths. There is no opt-out that restores the bypass.

## Audited published artifacts

Only published npm tarballs were examined, not rolling documentation. To reproduce, `npm pack @opencode/<name>@<version>` and compare against the registry integrity:

| Package | Integrity |
| --- | --- |
| `@opencode/core@2.0.8` | `sha512-W3nVNTgt3JdTUfi9TzTAPBm8atWU0Y/PusBvQTKJz3bOF+olrT1RoZYXdCgzTNEdZkdHeBOr07thUi+tLAnqXQ==` |
| `@opencode/plugin@2.0.8` | `sha512-GrcHjIePjXFsYT7XqVFPM7mYQJtbwtZGezmJTpAj28/n+7Mywliglrzxeqnm0RHvwNXMmKtPm9E2H6H+RdzL6w==` |
| `@opencode/util@2.0.8` | `sha512-hbZF8f4y1mlMza4Bigot9bm00yKsX8qRud8DZpThH2joYl8fZLoyqsp/i87zm4zrBLDzu4SCcpgYhSk1Av5dvg==` |
| `@opencode/core@2.0.19` | `sha512-vmVfQh8JDzkuUgMs87q+M6xtVWT5fSDwWy4jzfW0IpXkRb36vClxL5IoO9dPucBfWtDZlhQYQ/ju1HbYHtn4pw==` |
| `@opencode/plugin@2.0.19` | `sha512-2amsDgAFsJspRGDmbivK164s+HZXxBeEeeSL5fd02qetHR+nKIfg2w6GT+kvj0hya2UH69A7/QCkTJrSJx0UxQ==` |
| `@opencode/util@2.0.19` | `sha512-uenhQbof/3pMDrEozIsQpYHNnPfwIwe2UdlcFOoLApY5m1bmRv4VAOHxwX0Eh0BAyWz2h5ZEz5QoP4qflqFDsQ==` |

Generated chunk names are release-specific; search for the named symbol when repeating the audit.

### 2.0.8

- `@opencode/plugin/dist/promise/permission.d.ts`, `PermissionDomain`: only `list`, `get`, `reply`, and `hook`. No `assert`, `ask`, or `evaluate` request method. `hook("evaluate")` edits an already-running evaluation; it cannot request checks for extra paths.
- `@opencode/plugin/dist/promise/tool.d.ts`, `ToolHooks`: before-hooks have input and IDs, not an authorization capability.
- `@opencode/core/dist/chunks/provider-rdkgddmz.js:223`: `beforeExecute` precedes `executeTool`; rewritten input is passed into the executor. Code Mode also runs before-hooks before execution at line 204.
- `@opencode/core/dist/chunks/provider-2hd5d5xt.js:76-90`: the write executor resolves its input, then calls internal `permission.assert` for that resource before writing. This internal service is not exposed by the plugin context.
- `@opencode/core/dist/chunks/provider-v5fds5j5.js:208-227`: the patch executor collects original and move resources, asserts edit permissions, then mutates files.
- `@opencode/core/dist/chunks/provider-1gfgk62c.js:47-54`: hook failures propagate; a before-hook refusal prevents executor entry.

### 2.0.19

- `@opencode/plugin/dist/promise/permission.d.ts`: `PermissionDomain` is still `Pick<PermissionApi, "list" | "get" | "reply">` plus `hook`. No authorization-request method.
- `@opencode/core/dist/chunks/ripgrep-zs8srxkn.js:85-91,224-235`: `beforeExecute` triggers `tool`/`execute.before`, and the returned `event.input` is what `executeTool` receives. Code Mode (line 205) runs the same before-hook first.
- `@opencode/core/dist/chunks/ripgrep-54zxgqzr.js:47-55`: `trigger` yields each callback's effect in sequence; a failure aborts the call before the executor.
- Mutating tools are `write` (`ripgrep-v6f2zkdc.js`, input `path`), `edit` (`ripgrep-ec07y9k9.js`, input `path`) and `patch` (`ripgrep-1gq8q7z3.js`, input `patchText`), all with `permission: "edit"` and `codemode: false`. Each resolves its path then calls internal `permission.assert` (lines 81, 157 and 213) before writing. There is no `apply_patch` tool.
- `ripgrep-f5fzvqmp.js:42-45`, `resolvePath2`: `~` and `~/…` expand to `Global.Path.home` (`OPENCODE_TEST_HOME ?? os.homedir()` in `@opencode/util/dist/global.js`); other paths resolve against the location directory. `FSUtil.windowsPath` is the identity off Windows. The guard's `expandPath` mirrors this.
- `@opencode/util/dist/patch.js` `parse`: header lines are trimmed and matched with literal `startsWith("*** Add File: ")`, `Delete File`, `Update File`, and `Move to` (the last on a `trimEnd` line); paths are trimmed. The guard's `patchHeaders` uses the same rules on every line, a superset of what the host acts on.

## Input and lookup failure policy

A mutation (`edit`, `write`, `patch`, `apply_patch`) whose target paths cannot be extracted is refused before any lookup: a missing or renamed path field, a non-object input, or a patch without a recognised header. The host rejects genuinely invalid input anyway; refusing prevents a valid input the guard misread from passing unchecked.

Mutations require a successful fresh `chezmoi --no-tty managed --include=files,symlinks --path-style=all --format=json` inventory. The subprocess has stdin closed, a 15-second timeout and a 64 MiB output limit (Node's default of 1 MiB is within reach of real inventories). A missing binary, timeout, output overflow, nonzero exit, invalid JSON, malformed entries and unresolvable paths (for example `EACCES` or `ELOOP` on an ancestor) throw, and the refusal names the cause. No availability shortcut or cached negative lookup is used. A successfully validated inventory without a match is the only unmanaged result.

Paths are compared three ways: as given, with the parent resolved through symlinks, and fully resolved. Inventory entries are keyed as reported and with their parent resolved, so a symlinked destination (for example `/home` → `/var/home`) matches in both directions, while a managed symlink's referent is not confused with the link. On macOS and Windows comparisons fold case and Unicode normalisation form; on a case-sensitive volume there this can only over-block.

Reads use a separate best-effort advisory lookup: an inventory at most 30 seconds old (a mutation's fresh inventory refreshes it). Any failure leaves the read result unchanged.

## Evidence and limits

Deterministic unit tests cover source-allowed/target-denied ordering, unchanged explicit source input, denied explicit sources, no subprocess apply even on forged completion events, every managed source kind, all four patch headers and host trim rules, uninterpretable inputs, aliases, symlinked parents, subprocess timeout/overflow/exit reasons and lookup failures. The simulated authorization test is explicitly labeled as such. Path canonicalisation is tested against a real temporary filesystem.

The built-package smoke (`npm run test:integration`, also run in CI and before release) uses real isolated chezmoi and filesystem fixtures, but a mocked OpenCode hook context. It checks blocked target operations, no auto-apply after explicit source edits, encrypted refusal, refusal of an uninterpretable input, an inventory larger than 1 MiB, a symlinked destination directory, valid unmanaged paths and configuration-failure refusal. It is not a real-host permission test.

## Live host smoke

`scripts/native-tui-smoke.py` runs a real, isolated OpenCode server and terminal with a scripted loopback model and no real credentials or dotfiles.

- **2.0.8, 2026-09-20:** a native `patch` targeting a managed file was rejected by the before-hook with `Managed target mutation blocked`; the error reached the model and the file was not edited.
- **2.0.19, 2026-09-29:** the same run passed: native patch blocked, refusal received by the model, exactly one guard error toast rendered, source and target bytes unchanged, companion and processes shut down cleanly.

These confirm exception propagation through the real host. The source-allowed/target-denied policy matrix remains a mocked-host regression test, not a completed live permission-policy test; real user permission configuration was not changed.
