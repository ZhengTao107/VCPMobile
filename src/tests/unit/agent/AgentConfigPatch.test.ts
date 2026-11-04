import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { invokeMock, mockInvoke, clearInvokeMocks } from "@/tests/mocks/tauri";
import { patchAgentConfig, quickSwitchAgentId } from "@/features/agent/agentConfigPatch";
import { useModelStore, type ModelInfo } from "@/core/stores/modelStore";

const baseline = {
  id: "a1",
  name: "Nova",
  systemPrompt: "",
  mobileSystemPrompt: "旧提示词",
  model: "old-model",
  temperature: 0.7,
  contextTokenLimit: 32000,
  maxOutputTokens: 4000,
  streamOutput: true,
  useTemperature: true,
};

beforeEach(() => {
  setActivePinia(createPinia());
  clearInvokeMocks();
  mockInvoke("read_agent_config", () => JSON.parse(JSON.stringify(baseline)));
  mockInvoke("save_agent_config", (args) => args?.agent);
});

describe("quickSwitchAgentId", () => {
  it("只有单 Agent 会话可快切", () => {
    expect(quickSwitchAgentId({ id: "a1", type: "agent" })).toBe("a1");
    expect(quickSwitchAgentId({ id: "g1", type: "group" })).toBeNull();
    expect(quickSwitchAgentId({ id: "", type: "agent" })).toBeNull();
    expect(quickSwitchAgentId(null)).toBeNull();
  });
});

describe("patchAgentConfig", () => {
  it("快切只改 Agent 默认模型，其余字段与基线一致，不写话题级模型", async () => {
    const saved = await patchAgentConfig("a1", { model: "new-model" });
    expect(saved.model).toBe("new-model");
    const save = invokeMock.mock.calls.find(([command]) => command === "save_agent_config");
    expect(save?.[1]).toEqual({ agent: { ...baseline, model: "new-model" }, baseline });
    expect(invokeMock.mock.calls.find(([command]) => command === "read_agent_config")?.[1])
      .toEqual({ agentId: "a1", allowDefault: false });
    const commands = invokeMock.mock.calls.map(([command]) => command);
    expect(commands.some((command) => /topic/i.test(String(command)))).toBe(false);
  });

  it("选用预设只写移动端提示词，不动模型", async () => {
    await patchAgentConfig("a1", { mobileSystemPrompt: "预设正文" });
    const save = invokeMock.mock.calls.find(([command]) => command === "save_agent_config");
    expect(save?.[1]).toMatchObject({ agent: { model: "old-model", mobileSystemPrompt: "预设正文" } });
  });
});

describe("模型收藏排序", () => {
  it("收藏排在最前，其后热门，再按名称", () => {
    const store = useModelStore();
    store.models = ["z-model", "b-model", "hot-model", "fav-model", "a-model"]
      .map((id) => ({ id }) as ModelInfo);
    store.hotModels = ["hot-model"];
    store.favorites = ["fav-model", "z-model"];
    const order = store.sortedModels.map((model) => model.id);
    expect(order.slice(0, 2).sort()).toEqual(["fav-model", "z-model"]);
    expect(order.slice(2)).toEqual(["hot-model", "a-model", "b-model"]);
    expect(store.isFavorite("fav-model")).toBe(true);
    expect(store.isFavorite("a-model")).toBe(false);
  });
});
