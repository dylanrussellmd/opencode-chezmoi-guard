/**
 * Guidance builders: boxed, agent-readable messages. Encrypted guidance is
 * the refusal for an encrypted target; read guidance is prepended to read
 * results. The frame and titles are matched exactly by the TUI companion.
 */

import type { SourceKind } from "./types.js";

const HR = "━".repeat(53);

/** Render a consistent boxed guidance block. */
function box(title: string, lines: string[]): string {
  return ["", HR, title, HR, "", ...lines, HR, ""].join("\n");
}

export function buildEncryptedGuidance(targetPath: string, sourcePath: string): string {
  return box("🔒 CHEZMOI ENCRYPTED FILE — EDIT BLOCKED", [
    `Target:  ${targetPath}`,
    `Source:  ${sourcePath}`,
    "",
    "This file is ENCRYPTED in the source state (encrypted_ prefix / .age/.asc).",
    "The source bytes are ciphertext — writing plaintext to them would corrupt",
    "the entry, so this edit has been blocked before execution.",
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
 * Guidance prepended to `read` tool output for advised kinds. The agent
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
      "  • Direct target mutations are blocked. Explicitly edit the source",
      "    with normal permission-checked tools; automatic apply is disabled.",
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
