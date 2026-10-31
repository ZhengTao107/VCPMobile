import { describe, expect, it } from "vitest";
import {
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
