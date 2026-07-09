/**
 * Extract file paths from an apply_patch / unified-diff payload.
 *
 * apply_patch uses `*** Update|Create File: <path>` opcodes; classic
 * unified diffs use `--- a/<path>` / `+++ b/<path>` headers. We collect
 * every distinct path and exclude `/dev/null` (new/deleted file marker).
 */

/** Extract all distinct target paths referenced in a patch. */
export function extractPathsFromPatch(patchText: string): string[] {
  const paths = new Set<string>();

  for (const m of patchText.matchAll(/\*\*\*\s+(?:Update|Create)\s+File:\s+(.+)/g)) {
    paths.add((m[1] ?? "").trim());
  }
  for (const m of patchText.matchAll(/^---\s+(?:a\/)?(.+)$/gm)) {
    const p = (m[1] ?? "").trim();
    if (p !== "/dev/null") paths.add(p);
  }
  for (const m of patchText.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)) {
    const p = (m[1] ?? "").trim();
    if (p !== "/dev/null") paths.add(p);
  }

  return [...paths];
}
