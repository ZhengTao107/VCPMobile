import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  currentLocalMediaTargets,
  isLocalOrPrivateHost,
  rewriteLocalMediaUrl,
} from "@/core/utils/localMediaRewrite";
import { clearHtmlCache, filterTrustedRichHtml, renderMarkdownNodes } from "@/core/utils/astRenderer";
import type { MarkdownNode } from "@/core/types/chat";

const targets = {
  vcpServerUrl: "https://vcp.example.com/some/base/",
  syncHttpUrl: "http://111.228.0.186:5974",
};

describe("rewriteLocalMediaUrl", () => {
  it("6005 → vcpServerUrl origin，保留 /pw= 段、query 与 hash 原始字节", () => {
    expect(
      rewriteLocalMediaUrl("http://localhost:6005/pw=123456/images/小雪表情包/好耶.png?v=1&x=%E4%B8%AD#frag", targets),
    ).toBe("https://vcp.example.com/pw=123456/images/小雪表情包/好耶.png?v=1&x=%E4%B8%AD#frag");
  });

  it("5974 → syncHttpUrl origin", () => {
    expect(rewriteLocalMediaUrl("http://127.0.0.1:5974/files/a.png", targets)).toBe(
      "http://111.228.0.186:5974/files/a.png",
    );
  });

  it.each([
    "http://10.0.0.8:6005/a.png",
    "http://172.16.1.2:6005/a.png",
    "http://172.31.255.1:6005/a.png",
    "http://192.168.1.5:6005/a.png",
    "http://[::1]:6005/a.png",
    "HTTP://LOCALHOST:6005/a.png",
  ])("私网/回环主机改写：%s", (url) => {
    expect(rewriteLocalMediaUrl(url, targets)).toBe("https://vcp.example.com/a.png");
  });

  it.each([
    ["其他端口", "http://localhost:5973/a.png"],
    ["无端口", "http://localhost/a.png"],
    ["非私网 172.32", "http://172.32.0.1:6005/a.png"],
    ["公网主机", "http://111.228.0.186:6005/a.png"],
    ["file 协议", "file:///C:/Users/a.png"],
    ["Windows 盘符", "C:\\Users\\Tao\\a.png"],
    ["盘符正斜杠", "E:/code/a.png"],
    ["data URL", "data:image/png;base64,AAAA"],
    ["相对路径", "/images/a.png"],
    ["非法 URL", "http://[::1:6005/a.png"],
    ["空串", ""],
  ])("不改写：%s", (_name, url) => {
    expect(rewriteLocalMediaUrl(url, targets)).toBe(url);
  });

  it("目标为空、空白或非 http(s) 时不改写", () => {
    const url = "http://localhost:6005/a.png";
    expect(rewriteLocalMediaUrl(url, {})).toBe(url);
    expect(rewriteLocalMediaUrl(url, { vcpServerUrl: "   " })).toBe(url);
    expect(rewriteLocalMediaUrl(url, { vcpServerUrl: "ws://vcp.example.com" })).toBe(url);
    expect(rewriteLocalMediaUrl(url, { vcpServerUrl: "not a url" })).toBe(url);
    expect(rewriteLocalMediaUrl("http://localhost:5974/a.png", { vcpServerUrl: targets.vcpServerUrl })).toBe(
      "http://localhost:5974/a.png",
    );
  });

  it("已是目标 origin（如本机直连局域网地址）不重复改写", () => {
    const url = "http://192.168.1.5:6005/pw=1/images/x.png";
    expect(rewriteLocalMediaUrl(url, { vcpServerUrl: "http://192.168.1.5:6005" })).toBe(url);
    const remote = "https://vcp.example.com/pw=1/images/x.png";
    expect(rewriteLocalMediaUrl(remote, targets)).toBe(remote);
  });

  it("isLocalOrPrivateHost 边界", () => {
    expect(isLocalOrPrivateHost("127.8.9.10")).toBe(true);
    expect(isLocalOrPrivateHost("172.15.0.1")).toBe(false);
    expect(isLocalOrPrivateHost("192.169.0.1")).toBe(false);
    expect(isLocalOrPrivateHost("10.0.0.256")).toBe(false);
    expect(isLocalOrPrivateHost("localhost.example.com")).toBe(false);
  });
});

describe("渲染单点接入（astRenderer）", () => {
  beforeEach(() => {
    clearHtmlCache();
  });

  const withSettings = (settings: Record<string, unknown> | null) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    if (settings) pinia.state.value.settings = { settings };
  };

  it("无设置时 currentLocalMediaTargets 为空，渲染保持原样", () => {
    withSettings(null);
    expect(currentLocalMediaTargets()).toEqual({});
    const html = filterTrustedRichHtml('<img src="http://localhost:6005/a.png">');
    expect(html).toContain('src="http://localhost:6005/a.png"');
  });

  it("raw HTML：img/video/audio/source 的 src 与 poster 改写，a href 不改", () => {
    withSettings(targets);
    const html = filterTrustedRichHtml(
      '<img src="http://localhost:6005/pw=9/images/a.png">'
      + '<video poster="http://127.0.0.1:6005/p.jpg"><source src="http://192.168.1.5:5974/v.mp4"></video>'
      + '<audio src="http://localhost:6005/s.mp3"></audio>'
      + '<a href="http://localhost:6005/doc">doc</a>'
      + '<img src="file:///C:/x.png">',
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("img")?.getAttribute("src")).toBe("https://vcp.example.com/pw=9/images/a.png");
    expect(host.querySelector("video")?.getAttribute("poster")).toBe("https://vcp.example.com/p.jpg");
    expect(host.querySelector("source")?.getAttribute("src")).toBe("http://111.228.0.186:5974/v.mp4");
    expect(host.querySelector("audio")?.getAttribute("src")).toBe("https://vcp.example.com/s.mp3");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("http://localhost:6005/doc");
    expect(host.querySelectorAll("img")[1]?.getAttribute("src")).toBe("file:///C:/x.png");
  });

  it("AST image 节点改写，且不修改传入的节点数据", () => {
    withSettings(targets);
    const image = {
      type: "image",
      src: "http://localhost:6005/pw=9/images/b.png",
      alt: "b",
      title: "",
      needs_asset_conversion: false,
    };
    const nodes = [{ type: "paragraph", children: [image] }] as unknown as MarkdownNode[];
    const html = renderMarkdownNodes(nodes, "msg-local-media");
    expect(html).toContain('src="https://vcp.example.com/pw=9/images/b.png"');
    expect(image.src).toBe("http://localhost:6005/pw=9/images/b.png");
  });
});
