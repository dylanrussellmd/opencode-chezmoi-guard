/**
 * Guidance builders — boxed, agent-readable messages prepended to tool
 * output so the agent understands the chezmoi source-type it just touched.
 *
 * Every block uses a consistent frame (L2) so the agent can recognise the
 * guard's voice and act on the RECOMMENDATION line.
 */

import type { SourceKind } from "./types.js";

const HR = "━".repeat(53);

/** Render a consistent boxed guidance block (L2). */
function box(title: string, lines: string[]): string {
  return ["", HR, title, HR, "", ...lines, HR, ""].join("\n");
}

export function buildTemplateGuidance(
  targetPath: string,
  sourcePath: string,
  toolName: "edit" | "write",
): string {
  const isWrite = toolName === "write";
  const title = isWrite
    ? "⚠️  CHEZMOI TEMPLATE WARNING — WRITE OPERATION"
    : "ℹ️  CHEZMOI TEMPLATE — EDIT OPERATION";
  const action = isWrite
    ? "You attempted to WRITE to a chezmoi template target. The write hit the RENDERED target file, NOT the template source. These changes WILL be overwritten on the next `chezmoi apply`."
    : "You are editing a chezmoi TEMPLATE source file. It contains Go template syntax (e.g. {{ .chezmoi.os }}, {{ if }}, {{ range }}) rendered to produce the final target file.";

  return box(title, [
    `Target (rendered):  ${targetPath}`,
    `Source (template):  ${sourcePath}`,
    "",
    action,
    "",
    "GUIDANCE FOR YOUR PLAN:",
    "  • Go template syntax: {{ .chezmoi.os }}, {{ .chezmoi.arch }},",
    "    {{ if cond }}...{{ end }}, {{ range .list }}...{{ end }}",
    "  • Template variables come from chezmoi data (`chezmoi data`).",
    "  • After editing the source, `chezmoi apply` renders it to the target.",
    `  • See rendered output: \`chezmoi cat ${targetPath}\``,
    "  • See available data:  `chezmoi data`",
    "",
    isWrite
      ? `RECOMMENDATION: Cancel this write and \`edit\` the SOURCE template instead: ${sourcePath}`
      : "RECOMMENDATION: Edit carefully — preserve template logic. `chezmoi apply` will sync.",
  ]);
}

export function buildModifyGuidance(targetPath: string, sourcePath: string): string {
  return box("⚠️  CHEZMOI MODIFY SCRIPT — PARTIAL FILE MANAGER", [
    `Target:  ${targetPath}`,
    `Source:  ${sourcePath}`,
    "",
    "This file is managed by a chezmoi `modify_` script. The script reads the",
    "existing file on stdin, transforms it, and writes the output back.",
    "",
    "GUIDANCE FOR YOUR PLAN:",
    "  • Edits to the target may be PARTIALLY or FULLY overwritten when",
    "    `chezmoi apply` runs the modify script.",
    "  • To make persistent changes, edit the modify SCRIPT itself, or ensure",
    "    your changes land in sections the script preserves.",
    `  • Review the script: \`cat ${sourcePath}\``,
    "",
    "RECOMMENDATION: Proceed with caution. Your edit may not persist.",
  ]);
}

export function buildSymlinkGuidance(
  targetPath: string,
  sourcePath: string,
  actualPath: string,
): string {
  return box("🔗 CHEZMOI SYMLINK — FOLLOWED TO ACTUAL FILE", [
    `Target (symlink):   ${targetPath}`,
    `Source:             ${sourcePath}`,
    `Actual file:        ${actualPath}`,
    "",
    "This chezmoi-managed file is a symlink. The edit was redirected to the",
    "actual file the symlink points to. `chezmoi apply` will recreate the symlink.",
  ]);
}

export function buildEncryptedGuidance(targetPath: string, sourcePath: string): string {
  return box("🔒 CHEZMOI ENCRYPTED FILE — EDIT BLOCKED", [
    `Target:  ${targetPath}`,
    `Source:  ${sourcePath}`,
    "",
    "This file is ENCRYPTED in the source state (encrypted_ prefix / .age/.asc).",
    "The source bytes are ciphertext — writing plaintext to them would corrupt",
    "the entry. The edit was NOT redirected and should NOT proceed.",
    "",
    "GUIDANCE FOR YOUR PLAN:",
    `  • To edit: \`chezmoi edit ${targetPath}\`  (decrypts → editor → re-encrypts)`,
    "  • Programmatic: `chezmoi decrypt` → edit → `chezmoi encrypt`.",
    "",
    "RECOMMENDATION: Abandon this direct edit; use `chezmoi edit` instead.",
  ]);
}

/**
 * Kinds that get a read-time advisory. Reads of these targets can mislead an
 * agent that plans a follow-up edit: template targets differ byte-for-byte
 * from their editable source, modify_ targets are script-managed, and
 * encrypted targets cannot be edited directly at all.
 */
export type ReadAdvisedKind = Extract<SourceKind, "template" | "modify" | "encrypted">;

/**
 * Guidance prepended to `read` tool output for advised kinds. Unlike the
 * edit/write builders this never accompanies an arg rewrite — the agent
 * always receives the real on-disk target bytes, plus this advisory.
 */
export function buildReadGuidance(
  targetPath: string,
  sourcePath: string,
  kind: ReadAdvisedKind,
): string {
  if (kind === "template") {
    return box("ℹ️  CHEZMOI TEMPLATE — YOU ARE READING RENDERED OUTPUT", [
      `Target (rendered):  ${targetPath}`,
      `Source (template):  ${sourcePath}`,
      "",
      "This file is RENDERED from a chezmoi template. The editable source",
      "contains Go template syntax ({{ .chezmoi.os }}, {{ if }}, …) and its",
      "bytes DIFFER from what you just read wherever template logic appears.",
      "",
      "GUIDANCE FOR YOUR PLAN:",
      "  • To modify this file, READ THE SOURCE FIRST and base your edit",
      `    (oldString) on the SOURCE bytes: ${sourcePath}`,
      "  • Edits addressed to this target are redirected to the source by",
      "    chezmoi-guard — an oldString built from rendered bytes may not match.",
      "  • See available template data: `chezmoi data`",
      "",
      `RECOMMENDATION: Before editing, read the source template: ${sourcePath}`,
    ]);
  }

  if (kind === "modify") {
    return box("ℹ️  CHEZMOI MODIFY SCRIPT — TARGET IS SCRIPT-MANAGED", [
      `Target:                 ${targetPath}`,
      `Source (modify script): ${sourcePath}`,
      "",
      "This file's state is managed by a chezmoi `modify_` script: on apply,",
      "the script reads the current file on stdin and emits the new content.",
      "",
      "GUIDANCE FOR YOUR PLAN:",
      "  • Direct edits to the target may be PARTIALLY or FULLY overwritten",
      "    the next time `chezmoi apply` runs.",
      `  • For persistent changes, read and edit the modify script: ${sourcePath}`,
      "",
      `RECOMMENDATION: Read the modify script before planning an edit: ${sourcePath}`,
    ]);
  }

  // encrypted
  return box("🔒 CHEZMOI ENCRYPTED SOURCE — EDITS ARE BLOCKED", [
    `Target (plaintext on disk):  ${targetPath}`,
    `Source (ciphertext):         ${sourcePath}`,
    "",
    "This file is ENCRYPTED in the chezmoi source state. Reading the target",
    "is fine (it is plaintext on disk), but `edit`/`write` against it are",
    "BLOCKED by chezmoi-guard because the source bytes are ciphertext.",
    "",
    "GUIDANCE FOR YOUR PLAN:",
    `  • To edit: \`chezmoi edit ${targetPath}\`  (decrypts → editor → re-encrypts)`,
    "  • Programmatic: `chezmoi decrypt` → edit → `chezmoi encrypt`.",
    "",
    "RECOMMENDATION: Do not plan a direct edit/write; use `chezmoi edit`.",
  ]);
}

/** Map an internal notify level to a TUI toast variant. */
export function levelToVariant(level: "error" | "warn" | "info"): "error" | "warning" | "info" {
  if (level === "error") return "error";
  if (level === "warn") return "warning";
  return "info";
}

/** Human-readable label for a source kind, for toast/log messages. */
export function kindLabel(kind: SourceKind): string {
  return kind;
}
