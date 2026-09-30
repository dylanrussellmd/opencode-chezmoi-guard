/** V2 patch headers only: text in diff hunks is never a path substitution. */
export interface PatchHeader {
  line: number;
  operation: "Add" | "Update" | "Delete" | "Move";
  path: string;
}

const HEADERS = [
  ["*** Add File: ", "Add"],
  ["*** Update File: ", "Update"],
  ["*** Delete File: ", "Delete"],
  ["*** Move to: ", "Move"],
] as const;

/**
 * Mirrors `@opencode/util/patch` parse() in 2.0.8 and 2.0.19: each line is
 * trimmed, matched with a literal `startsWith`, and the remainder trimmed.
 * The host only accepts some headers in some positions; accepting every
 * header on every line is a superset, so no header the host acts on is missed.
 */
export function patchHeaders(text: string): PatchHeader[] {
  const headers: PatchHeader[] = [];
  for (const [line, content] of text.split("\n").entries()) {
    const header = content.trim();
    for (const [prefix, operation] of HEADERS) {
      if (!header.startsWith(prefix)) continue;
      const path = header.slice(prefix.length).trim();
      if (path) headers.push({ line, operation, path });
      break;
    }
  }
  return headers;
}
