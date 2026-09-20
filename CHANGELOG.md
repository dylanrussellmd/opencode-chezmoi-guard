# Changelog

## 2.0.0 (unpublished, security revision)

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
