# chezmoi-guard

Native OpenCode V2 guard for chezmoi-managed files. **Managed target mutations are blocked; automatic redirection and apply are disabled.**

## Compatibility and installation

Version 2.0.0 targets OpenCode **2.0.8**, verified against that release's plugin types and tool-execution source. V1 users should stay on 1.1.2.

```jsonc
{
  "plugins": ["@dylanrussell/chezmoi-guard@2.0.0"]
}
```

For local integration, use a default-exporting entry in a discovered `.opencode/plugins/` definition directory that re-exports `dist/plugin.js`. Do not rely on `file:` plugin URLs for the installed 2.0.8 loader.

Requires a working `chezmoi` CLI and configuration. Missing CLI, configuration errors, malformed inventories and lookup failures **block mutations**. A successful inventory with no matching path leaves ordinary unmanaged files and explicit source edits unchanged for normal host permission checks.

## Authorization boundary

OpenCode 2.0.8 executes tool before-hooks **before** its built-in tools check permissions. Rewriting a denied target to an allowed source loses the original target's authorization check. Running `chezmoi apply` in an after-hook would also write the target outside the tool permission system.

The published plugin permission domain exposes pending-request `list/get/reply` and an evaluation hook, but no authorization-request/assert API. The guard therefore uses the conservative fallback:

- Never rewrites tool input or invokes `chezmoi apply`.
- Blocks `edit`, `write`, `patch` and compatible `apply_patch` calls addressing managed targets, including templates, modify scripts and managed symlinks.
- Inspects every Add/Update/Delete/Move patch header before execution; a managed path blocks the whole patch.
- Checks existing filesystem aliases and symlinked ancestors against the managed inventory.
- Preserves original input for unmanaged operations and explicit source edits so native host permissions remain authoritative.
- Makes no permission decisions that grant access, auto-approves nothing, and provides no option to re-enable unverified redirection/apply.

When blocked, read the indicated source, then explicitly edit it through normal permission-checked tools. Symlink sources contain link definitions: inspect the definition and explicitly address the referent. Have the user review and synchronize the target separately. This release deliberately does **not** preserve V1 automatic redirect/apply parity.

See [SECURITY.md](SECURITY.md) for the exact 2.0.8 audit evidence and verification limits.

## Read advisories

Reads remain unchanged. Template, modify-script and encrypted-source advisories are prepended to successful read results while preserving structured content, output and metadata. Advisory lookup is best-effort; mutation lookup uses a separate fresh, validated inventory and fails closed.

## Scope and TUI support

Shell commands and arbitrary custom mutation tools are outside this plugin's interception scope. This is a guard for the named file tools, not a filesystem sandbox.

Server plugins in 2.0.8 have no V1 `client.tui.toast` API. Tool errors/read advisories are agent-visible; TUI toast parity requires a separate CLI companion and remains unresolved.

## Development and verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
```

Unit tests use a mocked V2 hook context. `test:integration` uses real isolated chezmoi files/processes and the built package, but a **mocked OpenCode host**. Its permission-order test is a deterministic simulation, not evidence of a real-host authorization run. No real-host permission test has been completed.

MIT © Dylan Russell
