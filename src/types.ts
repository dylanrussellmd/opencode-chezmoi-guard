/**
 * Shared types for chezmoi-guard.
 *
 * Source-type handling classifies a chezmoi source path into one of these
 * kinds, which determines how the guard treats an edit targeting the
 * rendered file:
 *   - run / exact / directories → skipped (scripts / structural markers)
 *   - modify_                   → passthrough with warning (partial file
 *                                 manager; target edits may be overwritten)
 *   - symlink_                  → read the link target, redirect to the
 *                                 actual file, apply after
 *   - encrypted_ / .age / .asc  → BLOCKED (cannot edit ciphertext)
 *   - .tmpl (templates)         → edit redirects to source + guidance;
 *                                 write warned (hits rendered target)
 *   - normal (dot_/private_/
 *     executable_/empty_)       → redirect to source, apply after
 */

export type SourceKind =
  | "run"
  | "modify"
  | "symlink"
  | "exact"
  | "encrypted"
  | "template"
  | "normal";

/** A resolved source mapping for a chezmoi-managed target. */
export interface ResolveResult {
  sourcePath: string;
  kind: SourceKind;
  checkedAt: number;
}

/**
 * Per-call redirect state stashed in a pending map keyed by
 * `${sessionID}:${callID}`. State is NOT smuggled through tool args (H1).
 * The after-hook reads it to decide what to sync or which guidance to emit.
 */
export type Redirect =
  | { type: "patch"; targets: string[] }
  | { type: "encrypted"; source: string; target: string }
  | { type: "tmpl-write-warn"; source: string; target: string }
  | { type: "tmpl-edit"; source: string; target: string }
  | { type: "symlink"; source: string; target: string; actual: string }
  | { type: "modify-warn"; source: string; target: string }
  | { type: "apply"; source: string; target: string };
