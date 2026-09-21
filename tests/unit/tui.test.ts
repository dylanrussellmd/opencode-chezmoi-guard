import type { Context, Route, SlotClaim } from "@opencode/plugin/tui/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEncryptedGuidance, buildReadGuidance } from "../../src/guidance.js";
import { createNotifications, mountNotifications } from "../../src/tui.js";

type Message = ReturnType<Context["data"]["session"]["message"]["list"]>[number];

function tool(
  name: string,
  state: Record<string, unknown>,
  id = "tool-1",
  messageID = "message-1",
): Message {
  return {
    type: "assistant",
    id: messageID,
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 1 },
    content: [{ type: "tool", id, name, time: { created: 1 }, state }],
  } as Message;
}

function blocked(id = "tool-1") {
  return tool(
    "edit",
    {
      status: "error",
      input: {},
      error: {
        type: "unknown",
        message: "[chezmoi-guard] Managed target mutation blocked: /private/target",
      },
    },
    id,
  );
}

function read(kind: "template" | "modify" | "encrypted") {
  return tool("read", {
    status: "completed",
    input: {},
    content: [
      { type: "text", text: buildReadGuidance("/private/target", "/private/source", kind) },
      { type: "text", text: "private file bytes" },
    ],
  });
}

describe("native TUI notifications", () => {
  afterEach(() => vi.useRealTimers());
  it("deduplicates by session and call, including repeated projections and navigation", () => {
    const notifications = createNotifications();
    expect(notifications.scan("a", [blocked()])?.variant).toBe("error");
    expect(notifications.scan("a", [blocked()])).toBeUndefined();
    expect(notifications.scan("b", [blocked()])?.variant).toBe("error");
    expect(notifications.scan("a", [blocked()])).toBeUndefined();
    expect(notifications.scan("a", [blocked(), blocked("tool-2")])?.message).toContain(
      "1 guarded mutation blocked",
    );
  });

  it.each(["template", "modify", "encrypted"] as const)(
    "recognizes %s read guidance without exposing paths or content",
    (kind) => {
      const notifications = createNotifications();
      const toast = notifications.scan("a", [read(kind)]);
      expect(toast?.variant).toBe("warning");
      expect(toast?.message).toContain("read advisory");
      expect(JSON.stringify(toast)).not.toContain("private");
      expect(notifications.scan("a", [read(kind)])).toBeUndefined();
    },
  );

  it("recognizes encrypted blocks and inventory failures", () => {
    for (const message of [
      buildEncryptedGuidance("/target", "/source"),
      "[chezmoi-guard] Cannot verify managed paths: invalid chezmoi inventory. Mutation blocked.",
    ]) {
      const result = createNotifications().scan("a", [
        tool("patch", { status: "error", input: {}, error: { type: "unknown", message } }),
      ]);
      expect(result?.variant).toBe("error");
    }
  });

  it("ignores non-tool prose, ordinary errors, in-progress tools and embedded markers", () => {
    const marker = buildReadGuidance("/target", "/source", "template");
    const messages = [
      { type: "user", id: "user", text: marker },
      { type: "assistant", id: "assistant", content: [{ type: "text", text: marker }] },
      tool("edit", { status: "running", input: {} }),
      tool("write", { status: "streaming", input: "" }),
      tool("edit", { status: "error", input: {}, error: { message: "Permission denied" } }),
      tool("shell", {
        status: "error",
        input: {},
        error: { message: "[chezmoi-guard] quoted" },
      }),
      tool("read", {
        status: "completed",
        input: {},
        content: [{ type: "text", text: `file contents quoting ${marker}` }],
      }),
      tool("read", {
        status: "completed",
        input: {},
        content: [{ type: "file", uri: "file:///fixture", mime: "text/plain" }],
      }),
    ] as Message[];
    expect(createNotifications().scan("a", messages)).toBeUndefined();
  });

  it("waits for a terminal result and summarizes a batch with failures taking precedence", () => {
    const notifications = createNotifications();
    expect(
      notifications.scan("a", [tool("edit", { status: "running", input: {} })]),
    ).toBeUndefined();
    const toast = notifications.scan("a", [blocked(), blocked("tool-2"), read("template")]);
    expect(toast?.variant).toBe("error");
    expect(toast?.message).toContain("2 guarded mutations blocked. 1 read advisories.");
    expect(notifications.scan("a", [blocked(), read("template")])).toBeUndefined();
  });

  it("subscribes only inside app, follows the active session and cleans up", async () => {
    vi.useFakeTimers();
    let route: Route = { type: "home" };
    let render: SlotClaim<"app">["render"] | undefined;
    let event: Parameters<Context["data"]["listen"]>[0] | undefined;
    const messages = new Map<string, Message[]>([
      ["a", [blocked()]],
      ["b", [read("modify")]],
    ]);
    const list = vi.fn((id: string) => messages.get(id) ?? []);
    const show = vi.fn();
    const unregister = vi.fn();
    const unsubscribe = vi.fn();
    const ctx = {
      data: {
        session: { message: { list } },
        listen: (callback: typeof event) => {
          event = callback;
          return unsubscribe;
        },
      },
      ui: {
        router: { current: () => route },
        toast: { show },
        slot: (claim: SlotClaim<"app">) => {
          expect(claim.append).toBe("app");
          render = claim.render;
          return unregister;
        },
      },
    } as unknown as Context;
    const stop = mountNotifications(ctx);
    expect(event).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    render?.({});
    expect(list).not.toHaveBeenCalled();
    route = { type: "session", sessionID: "a" };
    vi.advanceTimersByTime(2000);
    expect(show).toHaveBeenCalledTimes(1);
    route = { type: "session", sessionID: "b" };
    vi.advanceTimersByTime(1000);
    expect(show).toHaveBeenCalledTimes(2);
    route = { type: "session", sessionID: "a" };
    vi.advanceTimersByTime(1000);
    expect(show).toHaveBeenCalledTimes(2);
    messages.set("a", [blocked("new-call")]);
    const dispatch = (type: string) =>
      event?.({ details: { type } } as Parameters<NonNullable<typeof event>>[0]);
    dispatch("provider.updated");
    await Promise.resolve();
    expect(show).toHaveBeenCalledTimes(2);
    dispatch("session.execution.succeeded");
    dispatch("session.execution.succeeded");
    await Promise.resolve();
    expect(show).toHaveBeenCalledTimes(3);
    render?.({});
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    messages.set("a", [blocked("after-stop")]);
    dispatch("session.execution.succeeded");
    stop();
    stop();
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    render?.({});
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(3);
  });
});
