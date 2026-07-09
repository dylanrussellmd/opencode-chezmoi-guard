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
- Advises `read` calls: reading a target whose source is a template, `modify_` script, or encrypted entry prepends guidance pointing at the editable source — **without** rewriting the read or hiding the real on-disk content.
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

## Read advisory

`read` is never redirected — the agent always sees the real on-disk target bytes. But for three source kinds, a guidance block is prepended to the read output because a naive follow-up edit would misfire:

| Source kind | Why reads need an advisory |
| --- | --- |
| `.tmpl` (template) | Rendered target bytes ≠ source bytes. An `edit` `oldString` built from the rendered content will not match the source file the guard redirects to. The advisory says: read the source first. |
| `modify_` | The target is script-managed state; persistent changes belong in the modify script, so the advisory points at it. |
| `encrypted_` / `.age` / `.asc` | Reading the plaintext target is fine, but edits are blocked — the advisory pre-empts a doomed edit plan with `chezmoi edit`. |

Reads of `normal`/`symlink` targets stay silent: their edits are transparently redirected anyway, and a banner on every dotfile read would be pure context noise.

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

## Making changes & releasing

You never run `npm publish` or touch an npm token. The only npm command in the loop is `npm version` (a local file-edit + git-commit helper), and even that is wrapped by the release script.

### One-time setup (already done for this repo)

Publishing uses npm **Trusted Publishing (OIDC)** — no `NPM_TOKEN` secret is stored. The `Release` workflow mints a short-lived OIDC token that npm trusts because this repo is registered as a trusted publisher on npmjs.com. If a release ever fails with a 403/404 on the publish step, register the trusted publisher on npmjs.com → package settings → *Trusted Publishers* → add:

- Repository: `dylanrussellmd/opencode-chezmoi-guard`
- Workflow filename: `release.yml`
- Environment: *(leave blank)*

### The workflow

```sh
# 1. Make your changes on main (or a PR, merged to main).
npm test                 # full gate: lint + typecheck + build + test + coverage
git add -A && git commit # commit your changes
git push                 # push to main (CI runs the gate on node 20 + 22)

# 2. Cut a release. The script:
#      - refuses if main is dirty or out of sync with origin
#      - bumps package.json + src/version.ts (via the `version` hook)
#      - commits both as "<new-version>", tags vX.Y.Z
#      - pushes main + the tag
./scripts/release.sh patch    # 1.0.1 → 1.0.2
# ./scripts/release.sh minor  # 1.0.1 → 1.1.0
# ./scripts/release.sh major  # 1.0.1 → 2.0.0
# ./scripts/release.sh 1.5.0  # explicit version

# 3. Done. The Release workflow picks up the tag, re-runs the full gate,
#    and publishes to npm with signed build provenance. Watch it:
#    https://github.com/dylanrussellmd/opencode-chezmoi-guard/actions/workflows/release.yml
```

### What the release script guards against

- **Dirty work tree** — uncommitted changes would get swept into the version commit or left behind.
- **Wrong branch** — refuses to cut a release from anything but `main`.
- **Diverged main** — local `main` must match `origin/main` so the tag lands on a commit the runner can check out.

### How the version stays in sync

`package.json` and `src/version.ts` must always agree. `scripts/sync-version.mjs` runs as the npm `version` lifecycle hook during `./scripts/release.sh`: after `npm version` bumps `package.json`, the hook rewrites `src/version.ts` to match and stages it, so both files land in the same commit. The Release workflow also verifies the tag (`vX.Y.Z`) matches `package.json` `version` exactly, failing loudly if they drift.

## License

MIT © Dylan Russell
