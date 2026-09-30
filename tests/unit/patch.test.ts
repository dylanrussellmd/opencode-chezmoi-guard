import { describe, expect, it } from "vitest";
import { patchHeaders } from "../../src/patch.js";

const paths = (text: string) => patchHeaders(text).map((header) => header.path);

describe("native V2 patch headers", () => {
  it("extracts Add/Update/Delete/Move paths with spaces", () => {
    expect(
      patchHeaders("*** Add File: a b\n*** Update File: c\n*** Move to: d\n*** Delete File: e"),
    ).toEqual([
      { line: 0, operation: "Add", path: "a b" },
      { line: 1, operation: "Update", path: "c" },
      { line: 2, operation: "Move", path: "d" },
      { line: 3, operation: "Delete", path: "e" },
    ]);
  });
  it("ignores diff content, obsolete Create and unified headers", () => {
    expect(
      paths("+*** Update File: x\n *** Delete File: y\n*** Create File: z\n--- a/file\n+++ b/file"),
    ).toEqual(["y"]);
  });
  it("matches the host's trim rules: CRLF, padding, and Unicode whitespace", () => {
    expect(paths("*** Update File: old\r\n@@\r\n-old\r\n+old\r\n")).toEqual(["old"]);
    expect(paths("\t *** Add File:   /padded  \u00a0")).toEqual(["/padded"]);
    expect(paths("*** Add File: /a\u2028")).toEqual(["/a"]);
  });
  it("skips headers the host rejects: empty paths and missing separator space", () => {
    expect(paths("*** Add File: \n*** Move to:\n*** Delete File:/x\n*** Update File:\t/y")).toEqual(
      [],
    );
  });
});
