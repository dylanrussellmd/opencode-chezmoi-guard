/** Read-only notifications from OpenCode 2.0.8's projected session messages. */
import type { Plugin } from "@opencode/plugin/tui";
import type { Context, ToastOptions } from "@opencode/plugin/tui/context";

type Message = ReturnType<Context["data"]["session"]["message"]["list"]>[number];

const FRAME = "━".repeat(53);
const READ_TITLES = [
  "ℹ️  CHEZMOI TEMPLATE — YOU ARE READING RENDERED OUTPUT",
  "ℹ️  CHEZMOI MODIFY SCRIPT — TARGET IS SCRIPT-MANAGED",
  "🔒 CHEZMOI ENCRYPTED SOURCE — EDITS ARE BLOCKED",
];
const MUTATIONS = new Set(["edit", "write", "patch", "apply_patch"]);

function boxed(text: string, title: string): boolean {
  return text.startsWith(`\n${FRAME}\n${title}\n${FRAME}\n`);
}

/** Retain identities only, never paths, source bytes, or tool output. */
export function createNotifications() {
  const seen = new Map<string, Set<string>>();
  return {
    clear: () => seen.clear(),
    scan(sessionID: string, messages: readonly Message[]): ToastOptions | undefined {
      let identities = seen.get(sessionID);
      if (!identities) {
        identities = new Set();
        seen.set(sessionID, identities);
      }
      let failures = 0;
      let advisories = 0;
      for (const message of messages) {
        if (message.type !== "assistant") continue;
        for (const part of message.content) {
          if (part.type !== "tool") continue;
          const state = part.state;
          let kind: "failure" | "advisory" | undefined;
          if (state.status === "error" && MUTATIONS.has(part.name)) {
            const text = state.error.message;
            if (
              text.startsWith("[chezmoi-guard]") ||
              boxed(text, "🔒 CHEZMOI ENCRYPTED FILE — EDIT BLOCKED")
            ) {
              kind = "failure";
            }
          } else if (state.status === "completed" && part.name === "read") {
            const first = state.content[0];
            if (first?.type === "text" && READ_TITLES.some((title) => boxed(first.text, title))) {
              kind = "advisory";
            }
          }
          if (!kind) continue;
          const key = JSON.stringify([message.id, part.id, kind]);
          if (identities.has(key)) continue;
          identities.add(key);
          if (kind === "failure") failures++;
          else advisories++;
        }
      }
      if (!failures && !advisories) return;
      return {
        title: "chezmoi-guard",
        variant: failures ? "error" : "warning",
        duration: 8000,
        message: failures
          ? `${failures} guarded mutation${failures === 1 ? "" : "s"} blocked.${advisories ? ` ${advisories} read advisories.` : ""} See tool results for source guidance; automatic apply is disabled.`
          : `${advisories} managed-file read advisor${advisories === 1 ? "y" : "ies"}. Read the source guidance in the tool result before editing.`,
      };
    },
  };
}

export function mountNotifications(ctx: Context): () => void {
  const notifications = createNotifications();
  let disposed = false;
  let stopMounted = () => {};
  const unregister = ctx.ui.slot({
    append: "app",
    render: () => {
      if (disposed) return null;
      stopMounted();
      const scan = () => {
        if (disposed) return;
        const route = ctx.ui.router.current();
        if (route.type !== "session") return;
        const toast = notifications.scan(
          route.sessionID,
          ctx.data.session.message.list(route.sessionID),
        );
        if (toast) ctx.ui.toast.show(toast);
      };
      // Read projected messages after event dispatch; do not reconstruct them
      // from event deltas. A cache-only tick also catches navigation and cache
      // hydration that completes after an event. No network polling or Solid.
      let queued = false;
      let mounted = true;
      const unsubscribe = ctx.data.listen(({ details }) => {
        if (!details.type.startsWith("session.") || queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (mounted) scan();
        });
      });
      const timer = setInterval(scan, 1000);
      stopMounted = () => {
        mounted = false;
        unsubscribe();
        clearInterval(timer);
      };
      scan();
      return null;
    },
  });
  return () => {
    if (disposed) return;
    disposed = true;
    stopMounted();
    unregister();
    notifications.clear();
  };
}

const plugin: Plugin.Definition = {
  id: "chezmoi-guard.tui",
  setup(ctx) {
    return mountNotifications(ctx);
  },
};

export default plugin;
