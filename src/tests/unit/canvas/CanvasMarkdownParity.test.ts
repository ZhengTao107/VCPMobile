import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCanvasMarkdown, renderCanvasMarkdown } from "@/features/canvas/canvasMarkdown";
import { renderSafeMarkdown } from "@/core/utils/safeMarkdown";

const SAMPLE = [
  "# 标题一",
  "",
  "## 标题二",
  "",
  "### 标题三",
  "",
  "第一行",
  "第二行",
  "",
  "> 引用",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```js",
  "const a = 1;",
  "```",
  "",
  "质能 $E=mc^2$，H~2~O 与 CO_2，x^2^",
  "",
  "- [ ] 待办",
  "",
  "![b64](data:image/png;base64,AAAA) ![ok](https://a/b.png) [x](javascript:alert(1))",
].join("\n");

const mount = (markdown: string) => {
  const root = document.createElement("div");
  root.innerHTML = renderCanvasMarkdown(markdown);
  return root;
};

describe("Canvas 文稿渲染对齐电脑端", () => {
  it("标题、段内换行、引用与电脑端 marked gfm+breaks 结构一致", () => {
    const root = mount(SAMPLE);
    expect([...root.querySelectorAll("h1,h2,h3")].map((h) => `${h.tagName}:${h.textContent}`))
      .toEqual(["H1:标题一", "H2:标题二", "H3:标题三"]);
    // breaks: true → 段内单换行成 <br>
    expect(root.querySelector("p")?.innerHTML).toBe("第一行<br>第二行");
    expect(root.querySelector("blockquote > p")?.textContent).toBe("引用");
  });

  it("表格包进 .vdoc-table-scroll 横滚容器，表头表体结构保留", () => {
    const root = mount(SAMPLE);
    const table = root.querySelector(".vdoc-table-scroll > table");
    expect(table).not.toBeNull();
    expect([...table!.querySelectorAll("thead th")].map((c) => c.textContent)).toEqual(["A", "B"]);
    expect([...table!.querySelectorAll("tbody td")].map((c) => c.textContent)).toEqual(["1", "2"]);
    expect(root.querySelectorAll(".vdoc-table-scroll").length).toBe(1);
  });

  it("代码块为 pre > code.language-js，不做高亮", () => {
    const code = mount(SAMPLE).querySelector("pre > code");
    expect(code?.className).toBe("language-js");
    expect(code?.textContent).toBe("const a = 1;\n");
    expect(code?.querySelector("span")).toBeNull();
  });

  it("公式按电脑端保留原文不渲染 KaTeX；上下标走 inlineFormatting 扩展", () => {
    const root = mount(SAMPLE);
    expect(root.querySelector(".katex, math")).toBeNull();
    expect(root.textContent).toContain("$E=mc");
    const sub = [...root.querySelectorAll("sub")].map((n) => n.textContent);
    const sup = [...root.querySelectorAll("sup")].map((n) => n.textContent);
    expect(sub).toEqual(["2", "2"]);
    expect(sup).toContain("2");
  });

  it("净化规则同电脑端 sanitizePreviewHtml：去 input、data: 图与非 http 链接", () => {
    const root = mount(SAMPLE);
    expect(root.querySelector("input")).toBeNull();
    const imgs = [...root.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([null, "https://a/b.png"]);
    const link = [...root.querySelectorAll("a")].find((a) => a.textContent === "x");
    expect(link?.hasAttribute("href")).toBe(false);
  });

  it("解析层输出含上下标标签；聊天共享渲染不受影响", () => {
    expect(parseCanvasMarkdown("H~2~O")).toBe("<p>H<sub>2</sub>O</p>\n");
    expect(renderSafeMarkdown("H~2~O")).not.toContain("<sub>");
  });

  it("文稿样式只作用于 .canvas-doc .markdown-preview", () => {
    const css = readFileSync(resolve(__dirname, "../../../features/canvas/canvasDocument.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/([^{}]+)\{/g)]
      .flatMap((m) => m[1].split(/,(?![^()]*\))/))
      .map((s) => s.trim())
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(20);
    expect(selectors.filter((s) => !s.startsWith(".canvas-doc .markdown-preview"))).toEqual([]);
  });
});
