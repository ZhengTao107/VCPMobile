import { describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import { createSettingsRemote, mobileThemeFromComputer, type SettingsHttpResponse } from "@/core/sync/settingsRemote";
import { LEGACY_THEME_MAP } from "@/core/stores/theme";

const target = { baseUrl: "http://sync.example:5974", token: "test-token" };
const known = Object.keys(LEGACY_THEME_MAP).filter((name) => mobileThemeFromComputer(name));

function setup(applyResult: () => unknown = () => ({ ok: true })) {
  let themeFile: string | undefined = known[0];
  const applyComputerTheme = vi.fn(async () => applyResult());
  const remote = createSettingsRemote({
    getTarget: () => target,
    readLocal: () => ({ userName: "凌溯朝", themeMode: "light" }),
    applyLocal: vi.fn(),
    fetchSettings: async (): Promise<SettingsHttpResponse> => ({
      status: 200,
      body: { revision: "r", values: { userName: "凌溯朝", currentThemeMode: "light", currentThemeFile: themeFile } },
    }),
    putSettings: async () => ({ status: 200, body: {} }),
    applyComputerTheme,
  });
  return { remote, applyComputerTheme, setTheme: (name: string) => (themeFile = name) };
}

describe("settingsRemote 主题跟随电脑", () => {
  it("映射表里至少有两个可用主题", () => {
    expect(known.length).toBeGreaterThanOrEqual(2);
  });

  it("首次拉取套用，同值不重复，变化后再套用", async () => {
    const { remote, applyComputerTheme, setTheme } = setup();
    await remote.pull();
    expect(applyComputerTheme).toHaveBeenCalledWith(mobileThemeFromComputer(known[0]));
    await remote.pull();
    expect(applyComputerTheme).toHaveBeenCalledTimes(1);
    setTheme(known[1]);
    await remote.pull();
    expect(applyComputerTheme).toHaveBeenLastCalledWith(mobileThemeFromComputer(known[1]));
    expect(applyComputerTheme).toHaveBeenCalledTimes(2);
    remote.dispose();
  });

  it("手机上没有对应主题时不套用、只警告一次", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { remote, applyComputerTheme, setTheme } = setup();
    setTheme("themes-not-exist.css");
    await remote.pull();
    await remote.pull();
    expect(applyComputerTheme).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("themes-not-exist.css"))).toHaveLength(1);
    warn.mockRestore();
    remote.dispose();
  });

  it("套用失败时下次同步会重试", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let ok = false;
    const { remote, applyComputerTheme } = setup(() => ({ ok, themeKey: null, error: "x" }));
    await remote.pull();
    ok = true;
    await remote.pull();
    expect(applyComputerTheme).toHaveBeenCalledTimes(2);
    await remote.pull();
    expect(applyComputerTheme).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    remote.dispose();
  });
});
