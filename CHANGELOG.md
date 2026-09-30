# Changelog

## 2.1.0 (2026-09-29)

- Audited OpenCode 2.0.19 (hook order, error propagation, tool schemas, path expansion, patch parser) and passed the live-host smoke on it. The peer range is now exactly the audited releases, `2.0.8 || 2.0.19`; the development dependency is 2.0.19.
- Fail closed when a mutation's target path cannot be determined (unrecognised input shape, or a patch with no recognised header) instead of passing it through unchecked.
- chezmoi lookups run asynchronously with `--no-tty`, stdin closed, a 15-second timeout and a 64 MiB output limit. Previously an inventory over 1 MiB blocked every mutation, and a prompting template could hang the host. Refusals now name the cause.
- Match managed paths through a symlinked destination directory (e.g. `/home` → `/var/home`), and case-insensitively on macOS and Windows.
- Recognise encrypted sources by chezmoi's per-type attribute order (`create_encrypted_…`, `modify_encrypted_…`, custom encryption suffixes); honour `literal_` and `.literal`.
- Read advisories share a 30-second cached inventory, follow aliases, and never fail a read.
- Patch headers are parsed with the host's exact `startsWith`/trim rules.
- `~` expansion honours `OPENCODE_TEST_HOME`, like the host.
- Removed unused redirect-era guidance builders and patch rewriting; encrypted refusal text no longer mentions redirection.
- CI and release run the real-chezmoi integration smoke with a pinned, checksum-verified chezmoi; coverage floors raised to 95/90/95/95.

## 2.0.1 (2026-09-20)

- Match native OpenCode home-path expansion before managed-file checks, including `~` and `~/…` in edit/write inputs and patch headers.
- Update the development dependency lock to patched versions; the full npm audit reports no known advisories.
- Restore a read-only native terminal companion with session-scoped, deduplicated guard notifications and teardown cleanup. No apply or approval actions are exposed.

## 2.0.0 (2026-09-20)

- Removed automatic source redirection and subprocess apply after review identified a target-permission bypass. All managed target mutations now block before execution; explicit source edits retain native permission checks.
- Mutation discovery now requires a fresh validated inventory and fails closed on subprocess/configuration/JSON errors. Successful unmanaged lookups still pass through.
- Earlier redirect/apply parity claims below describe the superseded initial port, not the current release candidate.
- Added `SECURITY.md` with exact 2.0.8 API/order evidence and clearly labeled mocked-host verification limits.

### Initial port (superseded before publication)

- Breaking: native OpenCode V2 `id`/`setup` server plugin, targeting 2.0.8.
- Restored managed source redirection, template/modify advisories, recursive symlink handling, read guidance and successful-call-only targeted apply.
- Encrypted edits now throw before execution, including encrypted patch headers and symlink referents.
- V2 `patchText` supports Add/Update/Delete/Move detection; header-only atomic rewriting preserves diff content. Managed structural operations are explicitly refused pending a source-state migration.
- Relative paths use the current session location. Failed calls never apply; concurrent calls are isolated and cleanup clears pending state.
- Preserves permission evaluation; adds no auto-approval hooks.
- Replaces unsupported V1 toast calls with tool-result guidance. TUI toast parity requires a separate CLI companion.
- Release workflow requires a matching version tag even for manual runs.
