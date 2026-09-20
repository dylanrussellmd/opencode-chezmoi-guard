# OpenCode 2.0.8 authorization audit

## Finding and remedy

The initial V2 port had a permission bypass: the before-hook changed the target to its source before native permission checks, then the after-hook wrote the original target through a subprocess. An allowed source did not authorize a denied target.

The revised guard does not attempt to infer authorization from session configuration, pending requests, or a previously observed permission event. It blocks managed target mutations before execution, never changes tool input, and never runs apply. Explicit source edits remain ordinary host-authorized operations; they do not synchronize targets automatically. All managed source kinds and patch headers use this boundary, including symlink paths. There is no opt-out that restores the bypass.

## Audited published artifacts

Examined npm `@opencode/plugin@2.0.8` and `@opencode/core@2.0.8` (not rolling documentation):

- `@opencode/plugin/dist/promise/permission.d.ts`, `PermissionDomain`: only `list`, `get`, `reply`, and `hook`. No `assert`, `ask`, or `evaluate` request method. `hook("evaluate")` edits an already-running evaluation; it cannot request checks for extra paths.
- `@opencode/plugin/dist/promise/tool.d.ts`, `ToolHooks`: before-hooks have input and IDs, not an authorization capability.
- `@opencode/core/dist/chunks/provider-rdkgddmz.js:223`: `beforeExecute` precedes `executeTool`; rewritten input is passed into the executor. Code Mode also runs before-hooks before execution at line 204.
- `@opencode/core/dist/chunks/provider-2hd5d5xt.js:76-90`: the write executor resolves its input, then calls internal `permission.assert` for that resource before writing. This internal service is not exposed by the plugin context.
- `@opencode/core/dist/chunks/provider-v5fds5j5.js:208-227`: the patch executor collects original and move resources, asserts edit permissions, then mutates files.
- `@opencode/core/dist/chunks/provider-1gfgk62c.js:47-54`: hook failures propagate; a before-hook refusal prevents executor entry.

These package files were unpacked locally under `node_modules/core-audit/package/` for review; generated package chunk names are specific to 2.0.8.

## Lookup failure policy

Mutations require a successful fresh `chezmoi managed --include=files,symlinks --path-style=all --format=json` inventory. Missing binaries, nonzero subprocess exits, invalid JSON and malformed entries throw. No availability shortcut or cached negative lookup is used. A successfully validated inventory without a match is the only unmanaged result. Reads retain a separate best-effort advisory lookup.

## Evidence and limits

Deterministic unit tests cover source-allowed/target-denied ordering, unchanged explicit source input, denied explicit sources, no subprocess apply even on forged completion events, every managed source kind, all four patch headers, aliases, and lookup failures. The simulated authorization test is explicitly labeled as such.

The built-package smoke uses real isolated chezmoi and filesystem fixtures, but a mocked OpenCode hook context. It checks blocked target operations, no auto-apply after explicit source edits, encrypted refusal, valid unmanaged paths and configuration-failure refusal. It is not a real-host permission test. No real-host permission test has been completed; real user permission configuration was not changed.
# Live host smoke, 2026-09-20

OpenCode 2.0.8 loaded the local package as active. A no-op native `patch` targeting
an existing managed Markdown file was rejected by the before-hook with
`Managed target mutation blocked`; the error reached the agent and the file was
not edited. This confirms exception propagation through the real host. The
source-allowed/target-denied policy matrix remains a mocked-host regression test,
not a completed live permission-policy test.
