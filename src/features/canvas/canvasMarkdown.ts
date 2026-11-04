//! Canvas 文稿渲染：对齐电脑端 VCPChat Canvasmodules/canvas.js renderDocumentPreview（L3608-3622）。
//! 管线：marked（gfm + breaks）+ inlineFormatting.js 的上下标扩展 → sanitizePreviewHtml（L2168）。
//! 电脑 Canvas 不渲染 KaTeX / Mermaid / 代码高亮，这里也不渲染，保持两端看到的是同一份文稿。
//! 聊天、论坛、邮件仍走 core/utils/safeMarkdown，互不影响。

import { Marked, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { filterTrustedRichHtml } from "../../core/utils/astRenderer";

// 与 Canvasmodules/inlineFormatting.js 逐字一致。
const SUPERSCRIPT_CLOSED = /^\^([^\s^](?:[^\s^]*?[^\s^])?)\^/;
const SUPERSCRIPT_BARE = /^\^([0-9]+\*?)/;
const SUBSCRIPT_CLOSED = /^~(?!~)([^\s~](?:[^\s~]*?[^\s~])?)~(?!~)/;
const SUBSCRIPT_BARE = /^_([0-9]+)/;

function inlineExtension(
  name: "superscript" | "subscript",
  tagName: "sup" | "sub",
  patterns: RegExp[],
): TokenizerAndRendererExtension {
  const scanPattern = name === "superscript"
    ? /\^(?:[0-9]+|[^\s^]+\^)/
    : /~(?!~)[^\s~]+(?:~|(?=[\s.,;:!?()[\]{}]|$))/;
  return {
    name,
    level: "inline",
    start(source: string) {
      const index = String(source || "").search(scanPattern);
      return index >= 0 ? index : undefined;
    },
    tokenizer(source: string) {
      for (const pattern of patterns) {
        const match = source.match(pattern);
        if (!match) continue;
        const text = match[1] || "";
        return { type: name, raw: match[0], text, tokens: this.lexer.inlineTokens(text) };
      }
      return undefined;
    },
    renderer(token: Tokens.Generic) {
      return `<${tagName}>${this.parser.parseInline(token.tokens ?? [])}</${tagName}>`;
    },
  };
}

const canvasMarked = new Marked({ gfm: true, breaks: true });
canvasMarked.use({
  extensions: [
    inlineExtension("superscript", "sup", [SUPERSCRIPT_CLOSED, SUPERSCRIPT_BARE]),
    inlineExtension("subscript", "sub", [SUBSCRIPT_CLOSED, SUBSCRIPT_BARE]),
  ],
});

/** 未净化的 marked 输出；只供渲染与对照测试使用，不得直接进 v-html。 */
export function parseCanvasMarkdown(content: string): string {
  return canvasMarked.parse(String(content ?? ""), { async: false }) as string;
}

// 与电脑端 sanitizePreviewHtml 的移除列表一致。
const REMOVED_TAGS =
  "script, iframe, object, embed, style, link, meta, base, form, input, button, textarea, select, option, svg, math, canvas";

/** 电脑端 sanitizePreviewHtml 的移植，外加窄屏表格横滚包裹，最后过一遍产品安全基线。 */
export function sanitizeCanvasHtml(html: string): string {
  if (typeof document === "undefined") return "";
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll(REMOVED_TAGS).forEach((node) => node.remove());
  for (const node of Array.from(template.content.querySelectorAll("*"))) {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        if (!/^(https?:|mailto:|#)/i.test(value)) node.removeAttribute(attribute.name);
        else if (node.tagName === "A" && !value.startsWith("#")) node.setAttribute("rel", "noreferrer noopener");
      }
      // 电脑端拒绝 data: 等内联图，防止 Base64 被写进文稿。
      if (name === "src" && !/^(https?:|file:)/i.test(value)) node.removeAttribute(attribute.name);
    }
  }
  // 窄屏：表格放进横向滚动容器，类名沿用电脑端 .vdoc-table-scroll。
  for (const table of Array.from(template.content.querySelectorAll("table"))) {
    if (table.parentElement?.classList.contains("vdoc-table-scroll")) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "vdoc-table-scroll";
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  }
  return filterTrustedRichHtml(template.innerHTML);
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] as string);

export function renderCanvasMarkdown(content: string): string {
  try {
    return sanitizeCanvasHtml(parseCanvasMarkdown(content));
  } catch (error) {
    console.error("[CanvasMarkdown] render failed", error);
    return `<pre>${escapeHtml(String(content ?? ""))}</pre>`;
  }
}
