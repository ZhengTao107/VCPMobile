import { describe, expect, it } from "vitest";
import {
  CONFIG_PROFILE_FIELDS,
  CONFIG_STRING_FIELDS,
  CONFIG_STRING_PREFIX,
  buildConfigString,
  maskPreview,
  maskSecret,
  parseConfigString,
  toSettingsPatch,
} from "../../../core/config/configImport";

const full = {
  vcpServerUrl: "https://vcp.example.com",
  vcpApiKey: "sk-abcdef123456",
  syncServerUrl: "ws://111.228.0.186:5975/ws-sync",
  syncHttpUrl: "http://111.228.0.186:5974",
  syncToken: "sync-token-WXYZ",
};

/** 独立于被测模块的编码器，用来手工构造各种 payload */
function encode(payload: unknown, prefix = CONFIG_STRING_PREFIX): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(payload))) {
    binary += String.fromCharCode(byte);
  }
  return prefix + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function expectError(text: string, pattern: RegExp) {
  const result = parseConfigString(text);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(pattern);
}

describe("配置串往返", () => {
  it("build → parse 字段一致，label 支持中文", () => {
    const text = buildConfigString({ ...full, userName: "不导出" } as any, "主人的服务器");
    expect(text.startsWith(CONFIG_STRING_PREFIX)).toBe(true);
    expect(text.slice(CONFIG_STRING_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);

    const result = parseConfigString(text);
    expect(result).toEqual({ ok: true, config: { ...full, label: "主人的服务器" } });
  });

  it("build 只带非空字段，且与独立编码器格式兼容", () => {
    const text = buildConfigString({ ...full, vcpApiKey: "", syncToken: "  " });
    const result = parseConfigString(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).not.toHaveProperty("vcpApiKey");
      expect(result.config).not.toHaveProperty("syncToken");
    }
    expect(parseConfigString(encode({ v: 1, ...full }))).toEqual({ ok: true, config: full });
  });
});

describe("输入容忍", () => {
  const text = encode({ v: 1, ...full, label: "测试" });

  it.each([
    ["首尾空白", `  \n\t${text}  \r\n`],
    ["双引号", `"${text}"`],
    ["单引号", `'${text}'`],
    ["中文引号", `“${text}”`],
    ["引号外再有空白", `  "${text}"\n`],
    ["中间被折行", text.replace(/(.{16})/g, "$1\r\n")],
    ["标准 base64 带填充", text.replace(/-/g, "+").replace(/_/g, "/") + "=="],
  ])("%s", (_name, input) => {
    const result = parseConfigString(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.syncToken).toBe(full.syncToken);
  });
});

describe("非法输入", () => {
  it("拒绝空串、错前缀与裸 JSON", () => {
    expectError("", /为空/);
    expectError('""', /为空/);
    expectError(encode({ v: 1, ...full }, "vcpm2:"), /vcpm1:/);
    expectError(JSON.stringify({ v: 1, ...full }), /vcpm1:/);
  });

  it("拒绝损坏编码、非 JSON、非对象与错误版本", () => {
    expectError(`${CONFIG_STRING_PREFIX}@@@`, /编码损坏/);
    expectError(`${CONFIG_STRING_PREFIX}${btoa("not json")}`, /JSON/);
    expectError(encode([1, 2]), /格式不正确/);
    expectError(encode({ ...full }), /版本/);
    expectError(encode({ v: 2, ...full }), /版本/);
    expectError("x".repeat(20000), /过长/);
  });

  it.each([
    ["vcpServerUrl", "ws://vcp.example.com", /VCP 服务器地址.*http/],
    ["syncHttpUrl", "ftp://1.2.3.4:5974", /同步 HTTP 地址.*http/],
    ["syncHttpUrl", "wss://1.2.3.4:5974", /同步 HTTP 地址/],
    ["syncServerUrl", "https://1.2.3.4:5975", /同步 WebSocket 地址.*ws/],
    ["syncServerUrl", "not a url", /不是合法的 URL/],
  ])("%s=%s 协议非法", (field, value, pattern) => {
    expectError(encode({ v: 1, [field]: value }), pattern);
  });

  it("拒绝非字符串字段，且没有可导入字段时报错", () => {
    expectError(encode({ v: 1, syncToken: 123 }), /类型不正确/);
    expectError(encode({ v: 1, label: "只有标签" }), /没有可导入/);
    expectError(encode({ v: 1, vcpApiKey: "  ", syncHttpUrl: "" }), /没有可导入/);
  });
});

describe("部分字段只覆盖部分", () => {
  it("只返回出现的字段，未知键与 label 不进 patch", () => {
    const result = parseConfigString(
      encode({ v: 1, syncToken: " tok-1234 ", adminPassword: "x", extraJunk: { a: 1 }, label: "L" }),
    );
    expect(result).toEqual({ ok: true, config: { syncToken: "tok-1234", label: "L" } });
    if (result.ok) {
      expect(toSettingsPatch(result.config)).toEqual({ syncToken: "tok-1234" });
    }
  });

  it("空字符串字段视为未提供，不会清空已有设置", () => {
    const result = parseConfigString(encode({ v: 1, syncHttpUrl: full.syncHttpUrl, vcpApiKey: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(toSettingsPatch(result.config))).toEqual(["syncHttpUrl"]);
    }
  });

  it("patch 字段全部属于白名单", () => {
    const result = parseConfigString(encode({ v: 1, ...full }));
    if (!result.ok) throw new Error(result.error);
    expect(Object.keys(toSettingsPatch(result.config)).sort()).toEqual([...CONFIG_STRING_FIELDS].sort());
  });
});

describe("maskPreview", () => {
  it("Key/Token 只露后 4 位，URL 原样，缺席字段不列出", () => {
    const items = maskPreview({
      vcpServerUrl: full.vcpServerUrl,
      vcpApiKey: full.vcpApiKey,
      syncToken: full.syncToken,
      label: "L",
    });
    expect(items.map((i) => [i.field, i.value])).toEqual([
      ["vcpServerUrl", full.vcpServerUrl],
      ["vcpApiKey", "••••3456"],
      ["syncToken", "••••WXYZ"],
    ]);
    expect(JSON.stringify(items)).not.toContain("abcdef");
  });

  it("不超过 4 位的密钥整段遮蔽", () => {
    expect(maskSecret("abcd")).toBe("••••");
    expect(maskSecret("")).toBe("••••");
    expect(maskSecret("abcde")).toBe("••••bcde");
  });
});

// ------------------------------------------------------------------
// 连接档案（ptp4g#16）——以下地址与 Key 均为虚构测试值
// ------------------------------------------------------------------

const localProfile = { name: "本机", vcpServerUrl: "http://192.168.1.5:6005", vcpApiKey: "" };
const serverProfile = { name: "服务器", vcpServerUrl: "https://vcp.example.com", vcpApiKey: "sk-fake-server-9876" };

/** 读出配置串里的原始 JSON，用来断言外发内容 */
function decode(text: string): Record<string, unknown> {
  const b64 = text.slice(CONFIG_STRING_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0))));
}

describe("连接档案", () => {
  it("合法双档案往返，patch 写入档案与档位", () => {
    const text = buildConfigString({
      ...full,
      connectionProfiles: [localProfile, serverProfile],
      connectionProfileMode: "local",
    });
    const result = parseConfigString(text);
    expect(result).toEqual({
      ok: true,
      config: { ...full, connectionProfiles: [localProfile, serverProfile], connectionProfileMode: "local" },
    });
    if (!result.ok) return;
    const patch = toSettingsPatch(result.config);
    expect(patch.connectionProfiles).toEqual([localProfile, serverProfile]);
    expect(patch.connectionProfileMode).toBe("local");
    expect(patch.connectionProfiles).not.toBe(result.config.connectionProfiles);
  });

  it("只有档案也能导入；档案项多余键被丢弃", () => {
    const result = parseConfigString(
      encode({ v: 1, connectionProfiles: [{ ...serverProfile, junk: 1 }], connectionProfileMode: "server" }),
    );
    expect(result).toEqual({
      ok: true,
      config: { connectionProfiles: [serverProfile], connectionProfileMode: "server" },
    });
    if (result.ok) {
      expect(Object.keys(toSettingsPatch(result.config)).sort()).toEqual([...CONFIG_PROFILE_FIELDS].sort());
    }
  });

  it.each([
    ["非法名称", [{ ...serverProfile, name: "家里" }], /名称只能是/],
    ["名称非字符串", [{ ...serverProfile, name: 1 }], /名称只能是/],
    ["名称重复", [serverProfile, { ...serverProfile }], /重复/],
    ["超过 2 个", [localProfile, serverProfile, serverProfile], /最多 2 个/],
    ["不是数组", { ...serverProfile }, /连接档案：类型不正确/],
    ["档案不是对象", ["https://vcp.example.com"], /档案格式不正确/],
  ])("%s 整串拒绝", (_name, profiles, pattern) => {
    expectError(encode({ v: 1, ...full, connectionProfiles: profiles }), pattern);
  });

  it.each([
    ["ws 协议", "ws://vcp.example.com", /协议必须是 http/],
    ["ftp 协议", "ftp://1.2.3.4:6005", /协议必须是 http/],
    ["非 URL", "not a url", /不是合法的 URL/],
    ["空地址", "  ", /缺少服务器地址/],
  ])("档案地址 %s 拒绝", (_name, url, pattern) => {
    expectError(encode({ v: 1, connectionProfiles: [{ ...serverProfile, vcpServerUrl: url }] }), pattern);
  });

  it("档案 Key 非字符串拒绝", () => {
    expectError(encode({ v: 1, connectionProfiles: [{ ...serverProfile, vcpApiKey: 42 }] }), /API Key 类型不正确/);
  });

  it.each(["auto", "remote", 1])("mode=%s 拒绝", (mode) => {
    expectError(encode({ v: 1, ...full, connectionProfileMode: mode }), /连接档位：只允许 local \/ server/);
  });

  it("空档案数组与空档位视为未提供，不覆盖已有设置", () => {
    const result = parseConfigString(
      encode({ v: 1, syncToken: "tok-1234", connectionProfiles: [], connectionProfileMode: " " }),
    );
    expect(result).toEqual({ ok: true, config: { syncToken: "tok-1234" } });
    if (result.ok) expect(toSettingsPatch(result.config)).toEqual({ syncToken: "tok-1234" });
    expectError(encode({ v: 1, connectionProfiles: [], connectionProfileMode: "" }), /没有可导入/);
  });

  it("server-only 不含本机地址且强制 mode=server", () => {
    const text = buildConfigString(
      {
        ...full,
        vcpServerUrl: localProfile.vcpServerUrl,
        vcpApiKey: "sk-fake-local-1111",
        connectionProfiles: [localProfile, serverProfile],
        connectionProfileMode: "local",
      },
      "朋友版",
      { profiles: "server-only" },
    );
    const raw = decode(text);
    expect(JSON.stringify(raw)).not.toContain("192.168.1.5");
    expect(JSON.stringify(raw)).not.toContain("local");
    expect(raw.connectionProfiles).toEqual([serverProfile]);
    expect(raw.connectionProfileMode).toBe("server");
    expect(raw.vcpServerUrl).toBe(serverProfile.vcpServerUrl);
    expect(raw.vcpApiKey).toBe(serverProfile.vcpApiKey);
    expect(parseConfigString(text).ok).toBe(true);
  });

  it("server-only 没有服务器档案时不带档案、档位与顶层 VCP 地址", () => {
    const raw = decode(
      buildConfigString(
        { ...full, vcpServerUrl: localProfile.vcpServerUrl, connectionProfiles: [localProfile] },
        undefined,
        { profiles: "server-only" },
      ),
    );
    expect(raw).not.toHaveProperty("connectionProfiles");
    expect(raw).not.toHaveProperty("connectionProfileMode");
    expect(raw).not.toHaveProperty("vcpServerUrl");
    expect(raw).not.toHaveProperty("vcpApiKey");
  });

  it("导出时跳过 auto 档位与非法档案", () => {
    const raw = decode(
      buildConfigString({
        ...full,
        connectionProfileMode: "auto",
        connectionProfiles: [{ name: "家里", vcpServerUrl: "http://10.0.0.2", vcpApiKey: "" }, localProfile, { ...localProfile }],
      }),
    );
    expect(raw).not.toHaveProperty("connectionProfileMode");
    expect(raw.connectionProfiles).toEqual([localProfile]);
  });

  it("旧串兼容：不含新字段时解析、patch 与生成结果都不变", () => {
    expect(parseConfigString(encode({ v: 1, ...full }))).toEqual({ ok: true, config: full });
    expect(buildConfigString(full)).toBe(encode({ v: 1, ...full }));
    expect(buildConfigString(full, undefined, { profiles: "all" })).toBe(encode({ v: 1, ...full }));
    const result = parseConfigString(encode({ v: 1, ...full }));
    if (result.ok) {
      expect(toSettingsPatch(result.config)).not.toHaveProperty("connectionProfiles");
      expect(toSettingsPatch(result.config)).not.toHaveProperty("connectionProfileMode");
    }
  });

  it("maskPreview 每个档案一行、Key 只露后 4 位，档位一行", () => {
    const items = maskPreview({ connectionProfiles: [localProfile, serverProfile], connectionProfileMode: "server" });
    expect(items).toEqual([
      { field: "connectionProfiles.本机", label: "连接档案「本机」", value: "http://192.168.1.5:6005 · Key 未设置" },
      { field: "connectionProfiles.服务器", label: "连接档案「服务器」", value: "https://vcp.example.com · Key ••••9876" },
      { field: "connectionProfileMode", label: "连接档位", value: "服务器（server）" },
    ]);
    expect(JSON.stringify(items)).not.toContain("fake-server");
    expect(new Set(items.map((i) => i.field)).size).toBe(items.length);
  });
});
