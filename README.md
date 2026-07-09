<div align="center">

# chezmoi-guard

**Stop opencode agents from editing chezmoi-managed files out-of-band.**
Intercepts `edit` / `write` / `apply_patch`, redirects to the chezmoi source, then syncs.

[![npm version](https://img.shields.io/npm/v/@dylanrussell/chezmoi-guard.svg?color=06b6d4&label=npm&logo=npm&logoColor=white&style=flat-square)](https://www.npmjs.com/package/@dylanrussell/chezmoi-guard)
[![license](https://img.shields.io/npm/l/@dylanrussell/chezmoi-guard.svg?color=06b6d4&style=flat-square)](./LICENSE)
[![node](https://img.shields.io/node/v/@dylanrussell/chezmoi-guard.svg?color=06b6d4&logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org)
[![types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178C6.svg?logo=typescript&logoColor=white&style=flat-square)](https://www.typescriptlang.org)
[![tested with vitest](https://img.shields.io/badge/tested%20with-vitest-FCC72B.svg?logo=vitest&logoColor=black&style=flat-square)](https://vitest.dev)

</div>

---

## What it does

When an opencode agent edits a file that lives under your chezmoi source, the edit lands on the rendered **target** — not the source. The next `chezmoi apply` silently reverts it. This plugin fixes that transparently:

- Intercepts `edit`, `write`, and `apply_patch` tool calls.
- Asks `chezmoi managed` whether the target is chezmoi-managed.
- If it is, rewrites the tool args to operate on the **source** file.
- After the tool runs, executes `chezmoi apply --no-tty <target>` to sync the target from the freshly-edited source.
- Emits a TUI toast on every redirect, warning, or block.

No more "the agent edited my dotfile but chezmoi ate the change."

## Install

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "@dylanrussell/chezmoi-guard"
  ]
}
```

Requires the `chezmoi` CLI on `PATH`. The plugin silently no-ops when chezmoi is missing.

## Source-type handling

| Source prefix / suffix | Behaviour |
| --- | --- |
| `dot_` / `private_` / `executable_` / `empty_` (normal) | Redirect to source, `chezmoi apply` after |
| `.tmpl` (template) | `edit` → redirect to source + guidance; `write` → warn (hits rendered target, lost on apply) |
| `symlink_` | Read the link target, redirect to the actual file, `chezmoi apply` after |
| `modify_` | Passthrough with warning (partial file manager; target edits may be overwritten) |
| `encrypted_` / `.age` / `.asc` | **BLOCKED** with guidance (use `chezmoi edit` instead) |
| `run_` / `exact_` / directories | Skipped (scripts / structural markers) |

## Sync semantics

The guard edits the **source** before the target is touched, so the normal `chezmoi apply` is non-interactive (the target is clean). The `--no-tty` flag is added so that if the target has drifted out-of-band (`MM` status — a prior manual edit, or a template/modify passthrough), `chezmoi apply` **fails safe**: it exits non-zero and leaves the user's out-of-band edit intact, instead of hanging on a TTY prompt or silently discarding changes with `--force`.

## Debug

```sh
CHEZMOI_GUARD_DEBUG=1 opencode
```

Emits `[chezmoi-guard] ...` lines to stderr for every redirect, skip, warn, and block.

## How it differs from a bare `.mjs` file path

The original plugin was referenced as `plugin/chezmoi-guard/chezmoi-guard.mjs` — a local file path. opencode's plugin loader expects either an npm spec (`@scope/name`) or a `file://` URL for local plugins; a bare relative path is not reliably loaded as a plugin module. Publishing as an npm package and referencing it by name guarantees the loader imports and registers its hooks.

## Development

```sh
npm install
npm run build        # tsup → dist/plugin.js + dist/plugin.d.ts
npm test             # vitest run --coverage
npm run lint         # biome check
npm run typecheck    # tsc --noEmit
```

## Publishing

Tags drive releases. Publishing uses npm **Trusted Publishing (OIDC)** — no `NPM_TOKEN` secret is stored. The `Release` workflow mints a short-lived OIDC token that npm trusts because this repo is registered as a trusted publisher on npmjs.com.

**One-time setup** (after the first manual publish): on npmjs.com → package settings → *Trusted Publishers* → add:
- Repository: `dylanrussellmd/opencode-chezmoi-guard`
- Workflow filename: `release.yml`

```sh
npm version patch    # bumps package.json + src/version.ts, commits, tags
git push --follow-tags
# Release workflow runs the full gate, then `npm publish --provenance`
```

The workflow guards that the tag (`vX.Y.Z`) matches `package.json` `version` exactly, and skips (stays green) if the version is already on the registry.

## License

MIT © Dylan Russell
