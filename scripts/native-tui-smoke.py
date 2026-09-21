#!/usr/bin/env python3
"""Real OpenCode 2.0.8 + chezmoi + PTY; only the model endpoint is synthetic.

Run npm run build, then python3 scripts/native-tui-smoke.py.
Requires Linux, Python 3, chezmoi and OpenCode 2.0.8. Override the binary with
OPENCODE_TEST_BINARY and temp parent with TMPDIR. Evidence is retained in a
private directory; disposable HOME/config/state and child processes are removed.
"""

import base64
from contextlib import ExitStack
import fcntl
import http.server
import json
import os
import pathlib
import pty
import re
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time
import urllib.request


def stop_process(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def main(resources):
    os.umask(0o077)
    package = pathlib.Path(__file__).resolve().parents[1]
    binary = shutil.which(os.environ.get("OPENCODE_TEST_BINARY", "opencode"))
    chezmoi = shutil.which("chezmoi")
    assert binary and chezmoi, "OpenCode and chezmoi must be installed"
    assert (package / "dist/tui.js").exists(), "Run npm run build first"
    evidence = pathlib.Path(tempfile.mkdtemp(prefix="guard-native-tui-"))
    root = evidence / "fixture"
    resources.callback(shutil.rmtree, root, ignore_errors=True)
    for name in (
        "home",
        "source",
        "config/opencode",
        "data",
        "cache",
        "state",
        "bin",
        "observer",
        "home/project/.opencode/plugins/guard",
    ):
        (root / name).mkdir(parents=True, exist_ok=True)
    project = root / "home/project"
    target = root / "home/.guard-fixture"
    source = root / "source/dot_guard-fixture"
    status = evidence / "observer.json"
    env = {
        "PATH": str(root / "bin") + os.pathsep + os.environ["PATH"],
        "HOME": str(root / "home"),
        "LANG": "C.UTF-8",
        "TERM": "xterm-256color",
        "FIXTURE_TOKEN": "synthetic-only",
    }
    for kind in ("CONFIG", "DATA", "CACHE", "STATE"):
        env[f"XDG_{kind}_HOME"] = str(root / kind.lower())
    version = subprocess.check_output(
        [binary, "--version"], env=env, cwd=root, text=True
    ).strip()
    assert version in ("2.0.8", "opencode v2.0.8"), version
    (root / "chezmoi.toml").write_text("")
    args = [
        chezmoi,
        "--config",
        str(root / "chezmoi.toml"),
        "--source",
        str(root / "source"),
        "--destination",
        str(root / "home"),
        "--persistent-state",
        str(root / "chezmoi.boltdb"),
        "--cache",
        str(root / "chezmoi-cache"),
    ]
    (root / "bin/chezmoi").write_text("#!/bin/sh\nexec " + shlex.join(args) + ' "$@"\n')
    (root / "bin/chezmoi").chmod(0o700)
    original = b"unchanged fixture\n"
    source.write_bytes(original)
    subprocess.run(
        ["chezmoi", "apply", "--no-tty"],
        env=env,
        cwd=root,
        check=True,
        capture_output=True,
    )
    assert target.read_bytes() == original
    patch = f"*** Begin Patch\n*** Update File: {target}\n@@\n-unchanged fixture\n+MUTATED\n*** End Patch"
    requests = []
    provider_errors = []

    class Provider(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                names = [
                    t.get("function", {}).get("name") for t in body.get("tools", [])
                ]
                if not any(m.get("role") == "tool" for m in body["messages"]):
                    assert "patch" in names, f"Native patch missing: {names}"
                    delta = {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_guard_native",
                                "type": "function",
                                "function": {
                                    "name": "patch",
                                    "arguments": json.dumps({"patchText": patch}),
                                },
                            }
                        ],
                    }
                    finish = "tool_calls"
                else:
                    delta = {"role": "assistant", "content": "Fixture complete."}
                    finish = "stop"
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for chunk in (
                    {"delta": delta, "finish_reason": None},
                    {"delta": {}, "finish_reason": finish},
                ):
                    data = {
                        "id": "chatcmpl-fixture",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "fixture",
                        "choices": [{"index": 0, **chunk}],
                    }
                    self.wfile.write(("data: " + json.dumps(data) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
            except Exception as error:
                provider_errors.append(str(error))
                self.send_error(500)

    endpoint = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    resources.callback(endpoint.server_close)
    thread = threading.Thread(target=endpoint.serve_forever, daemon=True)
    thread.start()
    resources.callback(endpoint.shutdown)
    (project / "opencode.json").write_text(
        json.dumps(
            {
                # 2.0.8 exposes its native patch tool only for GPT-style IDs.
                "model": "fixture/gpt-5-fixture",
                "enabled_providers": ["fixture"],
                "providers": {
                    "fixture": {
                        "env": ["FIXTURE_TOKEN"],
                        "package": "@opencode/ai/providers/openai-compatible",
                        "settings": {
                            "baseURL": f"http://127.0.0.1:{endpoint.server_port}/v1",
                            "apiKey": "synthetic-only",
                        },
                        "models": {
                            "gpt-5-fixture": {
                                "name": "fixture",
                            }
                        },
                    }
                },
            }
        )
    )
    (project / ".opencode/plugins/guard/index.mjs").write_text(
        f"export {{ default }} from {json.dumps(str(package / 'dist/plugin.js'))};\n"
    )
    # Title generation is not part of this test and must not consume fixture replies.
    probe = project / ".opencode/plugins/title.mjs"
    probe.write_text(
        'export default { id: "fixture.title", async setup(ctx) { await ctx.session.hook("title", e => { e.result = "Guard fixture"; }); } };\n'
    )
    observer = """
import { writeFileSync } from "node:fs";
import guard from GUARD;
const flags = { mounted: false, nativeBlock: false, toastCount: 0, cleanup: false,
                subscriptions: 0, slots: 0 };
const save = () => writeFileSync(STATUS, JSON.stringify(flags));
export default { id: "fixture.guard-observer", setup(ctx) {
  const wrapped = { ...ctx,
    data: { ...ctx.data,
      listen(callback) { flags.subscriptions++; const stop = ctx.data.listen(callback);
        return () => { stop(); flags.subscriptions--; save(); }; },
      session: { ...ctx.data.session, message: { ...ctx.data.session.message,
        list(id) {
          const messages = ctx.data.session.message.list(id);
          flags.sessionID = id;
          flags.messages = messages.length;
          flags.projected = messages;
          for (const m of messages) if (m.type === "assistant") for (const p of m.content) {
            if (p.type !== "tool") continue;
            flags.tool = { name: p.name, state: p.state };
            if (p.name === "patch" && p.state.status === "error" &&
                p.state.error.message.startsWith("[chezmoi-guard]") &&
                p.state.error.message.includes("Managed target mutation blocked:") &&
                p.state.error.message.includes(TARGET)) flags.nativeBlock = true;
          }
          save(); return messages;
        }
      }}
    },
    ui: { ...ctx.ui,
      slot(claim) { flags.slots++; const stop = ctx.ui.slot({ ...claim, render(props) {
        flags.mounted = true; save(); return claim.render(props);
      }}); return () => { stop(); flags.slots--; save(); }; },
      toast: { ...ctx.ui.toast, show(toast) {
        ctx.ui.toast.show(toast);
        flags.toast = toast; flags.toastCount++; save();
      }}
    }
  };
  const cleanup = guard.setup(wrapped);
  return () => { cleanup?.(); flags.cleanup = true; save(); };
}};
"""
    for key, value in {
        "GUARD": str(package / "dist/tui.js"),
        "STATUS": str(status),
        "TARGET": str(target),
    }.items():
        observer = observer.replace(key, json.dumps(value))
    (root / "observer/tui.mjs").write_text(observer)
    env["OPENCODE_CLI_CONFIG_CONTENT"] = json.dumps(
        {
            "plugins": ["-*", str(root / "observer")],
            "keybinds": {"app.exit": "ctrl+q"},
            "tabs": {"enabled": False},
            "attention": {"notifications": False, "sound": False},
        }
    )
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server_log = root / "server.log"
    log = server_log.open("wb")
    resources.callback(log.close)
    server = subprocess.Popen(
        [binary, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
        env=env,
        cwd=project,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
    resources.callback(stop_process, server)
    password = None
    for _ in range(300):
        match = re.search(r"server password (\S+)", server_log.read_text())
        if match:
            password = match[1]
            break
        time.sleep(0.1)
    assert password, "Private host did not start"
    authorization = base64.b64encode(f"opencode:{password}".encode()).decode()
    env["OPENCODE_SERVER_PASSWORD"] = password
    env["OPENCODE_PASSWORD"] = password

    def request(route, body=None):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{route}",
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Authorization": f"Basic {authorization}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            value = json.loads(raw) if raw else None
            return value.get("data", value) if isinstance(value, dict) else value

    assert request("/api/info")["version"] == "2.0.8"
    (evidence / "location.json").write_text(json.dumps(request("/api/location")))
    for _ in range(100):
        plugins = request("/api/plugin")
        if any(
            p["id"] == "chezmoi-guard" and p["state"]["status"] == "active"
            for p in plugins
        ):
            break
        time.sleep(0.1)
    (evidence / "plugins.json").write_text(json.dumps(plugins))
    assert any(
        p["id"] == "chezmoi-guard" and p["state"]["status"] == "active" for p in plugins
    ), "Native guard must activate"
    session = request(
        "/api/session",
        {
            "location": {"directory": str(project)},
            "title": "Guard fixture",
            "agent": "build",
            "model": {"providerID": "fixture", "id": "gpt-5-fixture"},
        },
    )
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
    process = subprocess.Popen(
        [
            binary,
            "--server",
            f"http://127.0.0.1:{port}",
            "--session",
            session["id"],
            str(project),
        ],
        env=env,
        cwd=project,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    resources.callback(stop_process, process)
    os.close(slave)
    output = bytearray()

    def drain():
        if select.select([master], [], [], 0.1)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                pass

    flags = {}
    try:
        deadline = time.monotonic() + 60
        observed_at = None
        prompted = False
        while process.poll() is None and time.monotonic() < deadline:
            drain()
            if status.exists():
                try:
                    flags = json.loads(status.read_text())
                except json.JSONDecodeError:
                    continue
            if flags.get("sessionID") == session["id"] and not prompted:
                request(
                    f"/api/session/{session['id']}/prompt",
                    {"text": "Run the fixture patch once."},
                )
                prompted = True
            if flags.get("toastCount") and observed_at is None:
                observed_at = time.monotonic()
            if observed_at and time.monotonic() - observed_at > 3:
                break
    finally:
        if process.poll() is None:
            os.write(master, b"\x11")
            deadline = time.monotonic() + 8
            while process.poll() is None and time.monotonic() < deadline:
                drain()
        forced = process.poll() is None
        if forced:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        drain()
        os.close(master)
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid, signal.SIGKILL)
            server.wait()
        log.close()
        (evidence / "server.log").write_text(
            server_log.read_text().replace(password, "[fixture password]")
        )
        for file in (root / "data").rglob("*.log"):
            (evidence / (file.name + ".captured")).write_text(
                file.read_text(errors="replace").replace(password, "[fixture password]")
            )
        endpoint.shutdown()
        endpoint.server_close()
        thread.join(timeout=5)
        (evidence / "terminal.bin").write_bytes(output)
        (evidence / "requests.json").write_text(json.dumps(requests))
        if status.exists():
            flags = json.loads(status.read_text())
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
        result = {
            "version": version,
            "nativeBlock": flags.get("nativeBlock", False),
            "mounted": flags.get("mounted", False),
            "toastCount": flags.get("toastCount", 0),
            "toastError": flags.get("toast", {}).get("variant") == "error",
            "toastRendered": "1 guarded mutation blocked." in text,
            "targetUnchanged": target.read_bytes() == original,
            "sourceUnchanged": source.read_bytes() == original,
            "cleanup": flags.get("cleanup", False),
            "subscriptions": flags.get("subscriptions"),
            "slots": flags.get("slots"),
            "cleanExit": process.returncode == 0 and not forced,
            "providerErrors": provider_errors,
            "modelRequests": len(requests),
            "modelReceivedRefusal": any(
                m.get("role") == "tool"
                and "[chezmoi-guard]" in str(m.get("content"))
                and "Managed target mutation blocked:" in str(m.get("content"))
                for r in requests
                for m in r["messages"]
            ),
            "serverStopped": server.poll() is not None,
            "endpointStopped": not thread.is_alive(),
        }
        shutil.rmtree(root)
        result["fixtureRemoved"] = not root.exists()
        (evidence / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"evidence": str(evidence / "result.json"), **result}))
    assert all(
        result[k]
        for k in (
            "nativeBlock",
            "mounted",
            "toastRendered",
            "toastError",
            "modelReceivedRefusal",
            "targetUnchanged",
            "sourceUnchanged",
            "cleanup",
            "cleanExit",
            "fixtureRemoved",
            "serverStopped",
            "endpointStopped",
        )
    ), result
    assert (
        result["toastCount"] == 1
        and result["subscriptions"] == 0
        and result["slots"] == 0
    ), result
    assert not provider_errors and len(requests) == 2, result


if __name__ == "__main__":
    with ExitStack() as resources:
        main(resources)
