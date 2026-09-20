/** V2 patch headers only: text in diff hunks is never a path substitution. */
export interface PatchHeader {
  line: number;
  operation: "Add" | "Update" | "Delete" | "Move";
  path: string;
}

const HEADER = /^(\*\*\* (Add File|Update File|Delete File|Move to): )(.+)$/;

export function patchHeaders(text: string): PatchHeader[] {
  const headers: PatchHeader[] = [];
  for (const [line, content] of text.split("\n").entries()) {
    // OpenCode 2.0.8 trims outer whitespace on operation headers. Conservatively
    // recognize those headers too; ignoring them would bypass the guard.
    const match = HEADER.exec(content.trim());
    if (!match) continue;
    headers.push({
      line,
      operation: match[2]?.split(" ")[0] as PatchHeader["operation"],
      path: (match[3] ?? "").trim(),
    });
  }
  return headers;
}

export function extractPathsFromPatch(text: string): string[] {
  return [...new Set(patchHeaders(text).map((header) => header.path))];
}

export function rewritePatchHeaders(
  text: string,
  replacements: ReadonlyMap<number, string>,
): string {
  return text
    .split("\n")
    .map((line, index) => {
      const path = replacements.get(index);
      if (path === undefined) return line;
      const cr = line.endsWith("\r") ? "\r" : "";
      return (
        line.replace(/\r$/, "").replace(HEADER, (_match, prefix: string) => `${prefix}${path}`) + cr
      );
    })
    .join("\n");
}
