import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockInvoke, clearInvokeMocks, invokeMock } from "@/tests/mocks/tauri";
import {
  buildTranslationSegments,
  interpretTranslationResponse,
  normalizePmidCitationMarkers,
  parseBatchText,
  protectInlineSyntax,
  restoreInlineSyntax,
  translateDocumentContent,
  TranslationError,
  type TranslateBatchRequest,
} from "@/core/utils/canvasTranslation";
import {
  CANVAS_TRANSLATION_MODEL,
  CANVAS_TRANSLATION_TARGET_LANGUAGE,
  parseTranslationRecord,
  runCanvasTranslation,
  translationSettings,
} from "@/features/canvas/canvasTranslationRunner";

const fakeTranslate = (prefix = "译") => (request: TranslateBatchRequest) =>
  Promise.resolve(request.items.map((source, index) => `⟦${index + 1}⟧ ${prefix}${source}`).join("\n"));

describe("占位符保护", () => {
  it("PMID 标记与转义方括号被保护后原样还原", () => {
    const text = "见 [PMID: 12345678, 23456789] 与 \\[注\\] 以及 [12345678]";
    const { text: masked, protectedValues } = protectInlineSyntax(text);
    expect(masked).not.toMatch(/\d{8}/);
    expect(protectedValues).toHaveLength(4);
    expect(restoreInlineSyntax(masked, protectedValues)).toBe(text);
  });

  it("翻译后 PMID 数字与分组不变，并按电脑端归一", async () => {
    const result = await translateDocumentContent("Bone loss was seen [PMID: 12345678; PMID: 23456789].", {
      targetLanguage: "简体中文",
      translateBatch: fakeTranslate(),
    });
    expect(result.content).toBe("译Bone loss was seen [PMID: 12345678, 23456789].");
    expect(normalizePmidCitationMarkers("a ^[PMID: 12345678]^ `[PMID: 1]`")).toBe("a [PMID: 12345678] `[PMID: 1]`");
  });

  it("模型丢掉或多出占位符的行不被采纳", async () => {
    const result = await translateDocumentContent("Seen [PMID: 12345678].", {
      targetLanguage: "简体中文",
      translateBatch: (req) => Promise.resolve(`⟦1⟧ 见到。${req.retry ? "" : ""}`),
    }).catch((e) => e);
    expect(result).toBeInstanceOf(TranslationError);
    expect((result as TranslationError).code).toBe("TRANSLATION_INVALID_OUTPUT");
  });
});

describe("分段边界", () => {
  it("跳过 front matter、围栏、表格、注释、分隔线与参考文献条目，保留行首结构", () => {
    const content = [
      "---",
      "title: x",
      "---",
      "# Introduction",
      "> - Quoted item text",
      "```js",
      "const a = 1;",
      "```",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "<!-- note -->",
      "***",
      "1. First point here",
      "## References",
      "Smith J. A paper. 2020.",
      "## Appendix",
      "Tail text",
    ].join("\n");
    const segments = buildTranslationSegments(content);
    expect(segments.map((s) => [s.prefix, s.source])).toEqual([
      ["# ", "Introduction"],
      ["> - ", "Quoted item text"],
      ["1. ", "First point here"],
      ["## ", "References"],
      ["## ", "Appendix"],
      ["", "Tail text"],
    ]);
  });

  it("批次解析：缺行、重复、折行为 null；单行无编号可接受", () => {
    expect(parseBatchText("前言\n⟦1⟧ 甲\n⟦2⟧ 乙\n续行\n⟦3⟧ 丙\n⟦3⟧ 丁", 4)).toEqual(["甲", null, null, null]);
    expect(parseBatchText("只有一行", 1)).toEqual(["只有一行"]);
  });
});

describe("复用与纠错", () => {
  it("未改动的段复用上次译文，不再请求", async () => {
    const content = "Alpha line one\nBeta line two";
    const first = await translateDocumentContent(content, { targetLanguage: "简体中文", model: "m", translateBatch: fakeTranslate() });
    const batch = vi.fn(fakeTranslate("新"));
    const second = await translateDocumentContent(`${content}\nGamma line three`, {
      targetLanguage: "简体中文",
      model: "m",
      translateBatch: batch,
      previousTranslation: first,
    });
    expect(second.reusedCount).toBe(2);
    expect(second.requestedCount).toBe(1);
    expect(batch.mock.calls[0][0].items).toEqual(["Gamma line three"]);
    expect(second.content).toBe("译Alpha line one\n译Beta line two\n新Gamma line three");
  });

  it("英文正文原样返回进入纠错轮并加硬性要求", async () => {
    const batch = vi.fn((req: TranslateBatchRequest) =>
      req.retry ? fakeTranslate()(req) : Promise.resolve(req.items.map((s, i) => `⟦${i + 1}⟧ ${s}`).join("\n")),
    );
    const result = await translateDocumentContent("The cells were cultured overnight", {
      targetLanguage: "简体中文",
      translateBatch: batch,
    });
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[1][0].insist).toBe(true);
    expect(result.untranslatedCount).toBe(0);
  });
});

describe("响应解析", () => {
  it("JSON 与 SSE 成功响应", () => {
    expect(
      interpretTranslationResponse({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "⟦1⟧ 好" } }] }) }),
    ).toBe("⟦1⟧ 好");
    const sse = 'data: {"choices":[{"delta":{"content":"⟦1⟧ "}}]}\n\ndata: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    expect(interpretTranslationResponse({ status: 200, body: sse })).toBe("⟦1⟧ 好");
  });

  it("429 可重试、401 不可重试、截断报错", () => {
    const err = (status: number, body = '{"error":{"message":"x"}}') => {
      try {
        interpretTranslationResponse({ status, body });
      } catch (e) {
        return e as TranslationError;
      }
      throw new Error("expected throw");
    };
    expect(err(429).retryable).toBe(true);
    expect(err(401).retryable).toBe(false);
    expect(err(200, JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "length" }] })).code).toBe(
      "TRANSLATION_OUTPUT_TRUNCATED",
    );
  });
});

describe("翻译执行器", () => {
  beforeEach(() => clearInvokeMocks());

  it("无设置时用电脑端默认模型与语言", () => {
    expect(translationSettings({})).toEqual({ model: CANVAS_TRANSLATION_MODEL, targetLanguage: CANVAS_TRANSLATION_TARGET_LANGUAGE });
    expect(translationSettings({ canvasTranslationModel: "gemini-3.7-flash-tiered" }).model).toBe(CANVAS_TRANSLATION_MODEL);
  });

  it("经 Rust 通道请求并写入 .translations 记录", async () => {
    let saved: string | null = null;
    mockInvoke("canvas_translate_request", (args) => {
      const user = String(args?.user);
      const content = user.replace(/⟦(\d+)⟧ /g, "⟦$1⟧ 译");
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }), truncated: false };
    });
    mockInvoke("canvas_translation_save", (args) => {
      saved = String(args?.record);
    });
    const record = await runCanvasTranslation({
      name: "AAHS.txt",
      content: "Hello world",
      sourceSha: "s1",
      model: CANVAS_TRANSLATION_MODEL,
      targetLanguage: "简体中文",
    });
    const request = invokeMock.mock.calls.find(([command]) => command === "canvas_translate_request")![1]!;
    expect(request).toMatchObject({ model: CANVAS_TRANSLATION_MODEL, stream: false });
    expect(String(request.system)).toContain("译成简体中文");
    expect(record.content).toBe("译Hello world");
    expect(parseTranslationRecord(saved)).toMatchObject({ name: "AAHS.txt", sourceSha: "s1", content: "译Hello world" });
  });
});
