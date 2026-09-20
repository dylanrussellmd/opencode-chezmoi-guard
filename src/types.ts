/**
 * Shared types for chezmoi-guard.
 *
 * Source-type handling classifies a chezmoi source path into one of these
 * kinds. All managed mutation targets are blocked in the conservative V2
 * guard; these kinds select encrypted refusal and read advisory text:
 *   - run                        → no read advisory
 *   - directories                → skipped (excluded upstream by
 *                                 `chezmoi managed --include=files,symlinks`)
 *   - exact_ dirs                → NOT a skip kind. `exact_` is a directory
 *                                 attribute (prunes target entries absent from
 *                                 source); files inside an `exact_` dir are
 *                                 ordinary managed files.
 *   - modify_                   → partial-file-manager read advisory
 *   - symlink_                  → follow referent for read advisories only
 *   - encrypted_ / .age / .asc  → BLOCKED (cannot edit ciphertext)
 *   - .tmpl (templates)         → rendered-byte/source-byte read advisory
 *   - normal (dot_/private_/
 *     executable_/empty_)       → no special read advisory
 */

export type SourceKind = "run" | "modify" | "symlink" | "encrypted" | "template" | "normal";

/** A resolved source mapping for a chezmoi-managed target. */
export interface ResolveResult {
  sourcePath: string;
  kind: SourceKind;
  checkedAt: number;
}
