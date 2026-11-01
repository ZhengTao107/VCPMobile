import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import DistributedView from "@/features/distributed/DistributedView.vue";
import { invokeMock, mockInvoke } from "@/tests/mocks/tauri";
import { mountWithPinia } from "@/tests/utils/mount";

vi.mock("@/core/utils/platform", () => ({
  nativePlatform: "android",
  isAndroid: true,
  isIOS: false,
}));

// 以下地址与 Key 均为虚构测试值
function installMocks(overrides: Record<string, unknown>) {
  const settings = {
    userName: "tester",
    vcpServerUrl: "https://chat.invalid",
    vcpApiKey: "chat-fake-key",
    vcpLogUrl: "wss://log.invalid/ws",
    vcpLogKey: "log-fake-key",
    syncServerUrl: "",
    syncHttpUrl: "",
    syncToken: "",
    topicSummaryModel: "",
    syncLogLevel: "info",
    agentOrder: [],
    groupOrder: [],
    distributedWsUrl: "",
    distributedVcpKey: "",
    distributedDeviceName: "Phone",
    ...overrides,
  };
  mockInvoke("read_settings", () => settings);
  mockInvoke("update_settings", (args) => ({ ...settings, ...(args?.updates as object) }));
  mockInvoke("get_settings_recovery_status", () => ({ recoveredCorrupt: false }));
  mockInvoke("get_distributed_status", () => ({
    state: "disconnected",
    connected: false,
    server_id: null,
    client_id: null,
    registered_tools: 0,
    last_error: null,
    session_id: 0,
  }));
  mockInvoke("get_registered_tools_metadata", () => []);
  mockInvoke("get_distributed_tool_config_status", () => ({ state: "ready", message: null }));
}

const connectButton = (wrapper: ReturnType<typeof mountWithPinia>) =>
  wrapper.findAll("button").find((button) => button.text() === "连接")!;

const savedUpdates = () =>
  invokeMock.mock.calls
    .filter(([command]) => command === "update_settings")
    .map(([, args]) => (args as { updates: Record<string, unknown> }).updates);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DistributedView falls back to the VCPLog pair when distributed fields are empty", () => {
  it("connects with vcpLogUrl/vcpLogKey without echoing them into the inputs", async () => {
    installMocks({});
    const wrapper = mountWithPinia(DistributedView, { props: { isOpen: true } });
    try {
      await flushPromises();
      expect(
        wrapper.findAll(".settings-field input").map((input) => (input.element as HTMLInputElement).value),
      ).toEqual(["Phone", "", ""]);
      const button = connectButton(wrapper);
      expect(button.attributes("disabled")).toBeUndefined();
      await button.trigger("click");
      await flushPromises();
      expect(savedUpdates()).toEqual([
        expect.objectContaining({
          distributedWsUrl: "wss://log.invalid/ws",
          distributedVcpKey: "log-fake-key",
          distributedEnabled: true,
        }),
      ]);
    } finally {
      wrapper.unmount();
    }
  });

  it("keeps explicit distributed fields over the VCPLog pair", async () => {
    installMocks({ distributedWsUrl: "wss://dist.invalid/ws", distributedVcpKey: "dist-fake-key" });
    const wrapper = mountWithPinia(DistributedView, { props: { isOpen: true } });
    try {
      await flushPromises();
      await connectButton(wrapper).trigger("click");
      await flushPromises();
      expect(savedUpdates()).toEqual([
        expect.objectContaining({ distributedWsUrl: "wss://dist.invalid/ws", distributedVcpKey: "dist-fake-key" }),
      ]);
    } finally {
      wrapper.unmount();
    }
  });

  it("stays disabled when both pairs are empty", async () => {
    installMocks({ vcpLogUrl: "", vcpLogKey: "" });
    const wrapper = mountWithPinia(DistributedView, { props: { isOpen: true } });
    try {
      await flushPromises();
      expect(connectButton(wrapper).attributes("disabled")).toBeDefined();
    } finally {
      wrapper.unmount();
    }
  });
});
