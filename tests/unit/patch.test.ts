import { describe, expect, it } from "vitest";
import { extractPathsFromPatch, patchHeaders, rewritePatchHeaders } from "../../src/patch.js";

describe("native V2 patch headers", () => {
  it("extracts Add/Update/Delete/Move paths with spaces and deduplicates", () => {
    expect(
      extractPathsFromPatch(
        "*** Add File: a b\n*** Update File: c\n*** Move to: d\n*** Delete File: e\n*** Update File: c",
      ),
    ).toEqual(["a b", "c", "d", "e"]);
  });
  it("ignores diff content, obsolete Create and unified headers", () => {
    expect(
      extractPathsFromPatch(
        "+*** Update File: x\n *** Delete File: y\n*** Create File: z\n--- a/file\n+++ b/file",
      ),
    ).toEqual(["y"]);
  });
  it("preserves content, CRLF and literal dollars in replacement paths", () => {
    const text = "*** Update File: old\r\n@@\r\n-old\r\n+old\r\n";
    expect(patchHeaders(text)).toEqual([{ line: 0, operation: "Update", path: "old" }]);
    expect(rewritePatchHeaders(text, new Map([[0, "/source/$&$1"]]))).toBe(
      "*** Update File: /source/$&$1\r\n@@\r\n-old\r\n+old\r\n",
    );
  });
});
