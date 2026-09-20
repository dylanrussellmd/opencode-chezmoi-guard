// Real chezmoi + built package with a MOCKED OpenCode hook context.
// This is not a real-host permission test. All files live inside this repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
const { default: plugin } = await import(process.env.CHEZMOI_GUARD_TEST_ENTRY || new URL("../dist/plugin.js", import.meta.url).href);

const binary = execFileSync("which", ["chezmoi"], { encoding: "utf8" }).trim();
const root = mkdtempSync(resolve("node_modules/chezmoi-guard-smoke-"));
const source = join(root, "source");
const target = join(root, "home");
const bin = join(root, "bin");
const config = join(root, "chezmoi.toml");
const previousPath = process.env.PATH;
const hooks = new Map();
let cleanup;
let calls = 0;
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
try {
  for (const dir of [source, target, bin]) mkdirSync(dir);
  writeFileSync(config, "");
  const argv = ["--config", config, "--source", source, "--destination", target, "--persistent-state", join(root, "state.boltdb"), "--cache", join(root, "cache")];
  writeFileSync(join(bin, "chezmoi"), `#!/bin/sh\nexec ${[binary, ...argv].map(quote).join(" ")} "$@"\n`, { mode: 0o755 });
  process.env.PATH = bin + delimiter + previousPath;
  writeFileSync(join(source, "dot_plain"), "old\n");
  writeFileSync(join(source, "dot_template.tmpl"), '{{ "rendered" }}\n');
  writeFileSync(join(source, "symlink_dot_link.tmpl"), '{{ ".plain" }}\n');
  execFileSync("chezmoi", ["apply", "--no-tty"]);

  cleanup = await plugin.setup({
    location: { directory: "/wrong" },
    session: { get: async () => ({ location: { directory: target } }) },
    tool: { hook: async (name, callback) => { hooks.set(name, callback); return { dispose: async () => {} }; } },
  });
  const before = async (tool, input) => {
    const event = { tool, input, id: `call${++calls}`, sessionID: "session", agent: "build", messageID: "message" };
    await hooks.get("execute.before")(event);
    return event;
  };
  const after = async (event, status = "completed") => {
    const output = { ...event, status, result: { content: "original" }, error: { message: "failed" } };
    await hooks.get("execute.after")(output);
    return output;
  };

  for (const path of [".plain", ".template", ".link"]) {
    await assert.rejects(before("edit", { path }), /Managed target mutation blocked/);
    await assert.rejects(before("write", { path }), /Managed target mutation blocked/);
  }
  for (const header of ["Add File", "Update File", "Delete File", "Move to"]) {
    await assert.rejects(before("patch", { patchText: `*** ${header}: ${join(target, ".plain")}` }), /Managed target mutation blocked/);
  }
  assert.equal(readFileSync(join(source, "dot_plain"), "utf8"), "old\n");
  assert.equal(readFileSync(join(target, ".plain"), "utf8"), "old\n");
  const read = await after(await before("read", { path: ".template" }));
  assert.match(read.result.content, /READING RENDERED OUTPUT/);

  // A source edit is explicit and unchanged; this fixture simulates execution,
  // not permission authorization. The plugin must never apply it afterward.
  const explicit = await before("edit", { path: join(source, "dot_plain") });
  assert.equal(explicit.input.path, join(source, "dot_plain"));
  writeFileSync(explicit.input.path, "explicit source edit\n");
  writeFileSync(join(target, ".plain"), "manual drift\n");
  await after(explicit);
  assert.equal(readFileSync(join(target, ".plain"), "utf8"), "manual drift\n");
  const unmanaged = await before("write", { path: join(target, "unmanaged") });
  assert.equal(unmanaged.input.path, join(target, "unmanaged"));
  symlinkSync(join(target, ".plain"), join(target, "alias"));
  await assert.rejects(before("write", { path: "alias" }), /Managed target mutation blocked/);

  const identity = join(root, "identity.txt");
  execFileSync("chezmoi", ["age-keygen", "--output", identity], { stdio: "pipe" });
  const recipient = execFileSync("chezmoi", ["age-keygen", "-y", identity], { encoding: "utf8" }).trim();
  writeFileSync(config, `encryption = "age"\n[age]\nidentity = ${JSON.stringify(identity)}\nrecipient = ${JSON.stringify(recipient)}\n`);
  const ciphertext = execFileSync("chezmoi", ["encrypt"], { input: "secret fixture\n" });
  writeFileSync(join(source, "encrypted_dot_secret.age"), ciphertext);
  await assert.rejects(before("write", { path: ".secret" }), /EDIT BLOCKED/);
  symlinkSync(join(target, ".secret"), join(target, "dangling-alias"));
  await assert.rejects(before("write", { path: "dangling-alias" }), /EDIT BLOCKED/);
  await assert.rejects(before("patch", { patchText: `*** Delete File: ${join(target, ".secret")}` }), /EDIT BLOCKED/);
  assert.deepEqual(readFileSync(join(source, "encrypted_dot_secret.age")), ciphertext);
  // Malformed configuration must not turn a managed/encrypted path into an
  // unmanaged one, and must not reuse the earlier successful inventory.
  writeFileSync(config, "invalid = [");
  await assert.rejects(before("write", { path: ".secret" }), /lookup failed/);
  await assert.rejects(before("write", { path: "unmanaged" }), /lookup failed/);
  console.log("Real-chezmoi / mocked-host smoke passed: all managed mutations blocked, explicit source input unchanged, no auto-apply, encrypted refusal, lookup failure closed.");
} finally {
  await cleanup?.();
  process.env.PATH = previousPath;
  rmSync(root, { recursive: true, force: true });
}
