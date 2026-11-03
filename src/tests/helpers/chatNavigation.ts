import { mockInvoke } from "@/tests/mocks/tauri";

/** 上游 426deddd 起会话导航由 Rust 仲裁；测试里按受理即生效模拟。 */
export function mockChatNavigation(options: { reject?: (target: unknown) => boolean } = {}) {
  let revision = 0;
  const empty = { target: { kind: "welcome" }, focusRevision: 0, windowRevision: 0, anchorId: null };
  mockInvoke("connect_chat_view", () => ({ documentId: 1, focus: empty }));
  mockInvoke("register_chat_navigation_intent", () => ({ focus: empty }));
  mockInvoke("request_chat_navigation", (args) => options.reject?.(args?.target) ? { status: "rejected" } : ({
    status: "accepted",
    focus: { target: args?.target, focusRevision: ++revision, windowRevision: revision, anchorId: args?.anchorId ?? null },
  }));
  mockInvoke("restore_chat_view", (args) => ({
    status: "accepted",
    focus: { target: args?.hint, focusRevision: ++revision, windowRevision: revision, anchorId: null },
  }));
}
