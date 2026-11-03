import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import {
  computerThemeFromMobile,
  createSettingsRemote,
  localFromRemote,
  mobileThemeFromComputer,
  remoteFromLocal,
  SETTINGS_BACKOFF_MIN_MS,
  SETTINGS_PUSH_DEBOUNCE_MS,
  type LocalSyncedSettings,
  type SettingsHttpResponse,
  type SettingsRemoteDeps,
} from "@/core/sync/settingsRemote";

const target = { baseUrl: "http://sync.example:5974", token: "test-token" };

function makeRemote(
  initial: LocalSyncedSettings,
  remoteValues: Record<string, unknown>,
  overrides: Partial<SettingsRemoteDeps> = {},
) {
  const local: LocalSyncedSettings = { ...initial };
  let clock = 1_000;
  const fetchSettings = vi.fn(
    async (): Promise<SettingsHttpResponse> => ({
      status: 200,
      body: { revision: "r1", values: remoteValues },
    }),
  );
  const putSettings = vi.fn(
    async (_t: unknown, values: Record<string, string>): Promise<SettingsHttpResponse> => ({
      status: 200,
      body: { values },
    }),
  );
  const applyLocal = vi.fn((patch: Partial<LocalSyncedSettings>) => {
    Object.assign(local, patch);
  });
  const remote = createSettingsRemote({
    getTarget: () => target,
    readLocal: () => ({ ...local }),
    applyLocal,
    fetchSettings,
    putSettings,
    now: () => clock,
    ...overrides,
  });
  const tick = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };
  return { remote, local, fetchSettings, putSettings, applyLocal, tick };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("key mapping", () => {
  it("round-trips userName and theme mode; drops keys the phone has no equivalent for", () => {
    const local = localFromRemote({
      userName: " 凌溯朝 ",
      currentThemeMode: "dark",
      filterRules: [],
      appearanceProfile: { density: "compact" },
    });
    expect(local).toEqual({ userName: "凌溯朝", themeMode: "dark" });
    expect(remoteFromLocal(local)).toEqual({ userName: "凌溯朝", currentThemeMode: "dark" });
  });

  it("ignores invalid values instead of overwriting", () => {
    expect(localFromRemote({ userName: "  ", currentThemeMode: "sepia" })).toEqual({});
    expect(localFromRemote(null)).toEqual({});
    expect(remoteFromLocal({ userName: "" })).toEqual({});
  });

  it("maps computer theme file names to mobile ids and back", () => {
    expect(mobileThemeFromComputer("themes星渊雪境.css")).toBe("themes-star-abyss.ts");
    expect(computerThemeFromMobile("themes-star-abyss.ts")).toBe("themes星渊雪境.css");
    expect(computerThemeFromMobile(mobileThemeFromComputer("themesEva.css"))).toBe("themesEva.css");
  });

  it("returns null when a theme cannot be mapped", () => {
    expect(mobileThemeFromComputer("themes不存在.css")).toBeNull();
    expect(mobileThemeFromComputer("themes-star-abyss.ts")).toBeNull();
    expect(mobileThemeFromComputer(42)).toBeNull();
    expect(computerThemeFromMobile("themes-unknown.ts")).toBeNull();
  });
});

describe("createSettingsRemote", () => {
  it("first pull applies computer values and does not push them back", async () => {
    const { remote, local, putSettings, tick } = makeRemote(
      { userName: "User", themeMode: "light" },
      { userName: "凌溯朝", currentThemeMode: "dark" },
    );
    await remote.pull();
    expect(local).toEqual({ userName: "凌溯朝", themeMode: "dark" });
    tick(SETTINGS_PUSH_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(putSettings).not.toHaveBeenCalled();
  });

  it("does not push before the first successful pull", async () => {
    const { remote, local, putSettings, tick } = makeRemote(
      { userName: "User", themeMode: "light" },
      {},
    );
    local.themeMode = "dark";
    remote.schedulePush();
    tick(SETTINGS_PUSH_DEBOUNCE_MS * 2);
    expect(putSettings).not.toHaveBeenCalled();
  });

  it("debounces local changes into one PUT with only the changed key", async () => {
    const { remote, local, putSettings, tick } = makeRemote(
      { userName: "凌", themeMode: "light" },
      { userName: "凌", currentThemeMode: "light" },
    );
    await remote.pull();
    local.themeMode = "dark";
    remote.schedulePush();
    tick(1_000);
    local.themeMode = "system";
    remote.schedulePush();
    tick(SETTINGS_PUSH_DEBOUNCE_MS - 1);
    expect(putSettings).not.toHaveBeenCalled();
    tick(1);
    await vi.waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));
    expect(putSettings).toHaveBeenCalledWith(target, { currentThemeMode: "system" });
    // 推成功后基线前移，同值不再重复推。
    remote.schedulePush();
    tick(SETTINGS_PUSH_DEBOUNCE_MS);
    await Promise.resolve();
    expect(putSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps an unpushed local edit over a later remote value", async () => {
    let remoteValues: Record<string, unknown> = { userName: "凌", currentThemeMode: "light" };
    const { remote, local, putSettings, tick } = makeRemote(
      { userName: "凌", themeMode: "light" },
      {},
      {
        fetchSettings: async () => ({ status: 200, body: { values: remoteValues } }),
      },
    );
    await remote.pull();
    local.themeMode = "dark";
    remoteValues = { userName: "溯朝", currentThemeMode: "system" };
    await remote.pull();
    expect(local).toEqual({ userName: "溯朝", themeMode: "dark" });
    tick(SETTINGS_PUSH_DEBOUNCE_MS);
    await vi.waitFor(() => expect(putSettings).toHaveBeenCalledTimes(1));
    expect(putSettings).toHaveBeenCalledWith(target, { currentThemeMode: "dark" });
  });

  it("does nothing without sync target (autoSync off or missing url/token)", async () => {
    const { remote, local, fetchSettings, putSettings, tick } = makeRemote(
      { userName: "User", themeMode: "light" },
      { userName: "凌" },
      { getTarget: () => null },
    );
    await remote.pull();
    local.userName = "改过";
    remote.schedulePush();
    tick(SETTINGS_PUSH_DEBOUNCE_MS * 2);
    expect(fetchSettings).not.toHaveBeenCalled();
    expect(putSettings).not.toHaveBeenCalled();
  });

  it("backs off silently on 404/503 and retries after the window", async () => {
    const fetchSettings = vi.fn(async (): Promise<SettingsHttpResponse> => ({ status: 404, body: null }));
    const { remote, tick } = makeRemote({ userName: "U", themeMode: "light" }, {}, { fetchSettings });
    await remote.pull();
    await remote.pull();
    expect(fetchSettings).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
    tick(SETTINGS_BACKOFF_MIN_MS);
    fetchSettings.mockResolvedValueOnce({ status: 503, body: null });
    await remote.pull();
    expect(fetchSettings).toHaveBeenCalledTimes(2);
    // 第二次退避翻倍。
    tick(SETTINGS_BACKOFF_MIN_MS);
    await remote.pull();
    expect(fetchSettings).toHaveBeenCalledTimes(2);
    tick(SETTINGS_BACKOFF_MIN_MS);
    await remote.pull();
    expect(fetchSettings).toHaveBeenCalledTimes(3);
  });

  it("drops the sync baseline when applying remote values fails", async () => {
    const applyLocal = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { remote, local, putSettings, tick } = makeRemote(
      { userName: "User", themeMode: "light" },
      { userName: "凌" },
      { applyLocal },
    );
    await remote.pull();
    local.themeMode = "dark";
    remote.schedulePush();
    tick(SETTINGS_PUSH_DEBOUNCE_MS * 2);
    expect(putSettings).not.toHaveBeenCalled();
  });

  it("dispose cancels a pending push", async () => {
    const { remote, local, putSettings, tick } = makeRemote(
      { userName: "凌", themeMode: "light" },
      { userName: "凌", currentThemeMode: "light" },
    );
    await remote.pull();
    local.userName = "新名字";
    remote.schedulePush();
    remote.dispose();
    tick(SETTINGS_PUSH_DEBOUNCE_MS * 2);
    expect(putSettings).not.toHaveBeenCalled();
  });
});
