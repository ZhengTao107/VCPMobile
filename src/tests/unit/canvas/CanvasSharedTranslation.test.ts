import { describe, expect, it, vi } from "vitest";
import "@/tests/mocks/tauri";
import {
  canvasDocKey,
  fromSharedRecord,
  loadSharedTranslation,
  saveSharedTranslation,
  sharedTranslationFileName,
  toSharedRecord,
} from "@/features/canvas/canvasSharedTranslation";
import { getSegmentTranslationKey, sha256Hex } from "@/core/utils/canvasTranslation";
import type { CanvasTranslationRecord } from "@/features/canvas/canvasTranslationRunner";

// 期望值由电脑端真实模块算出（E:\code\VCPChat modules/services/canvasDocKey.js、canvasTranslationCache.js，11-03 19:1x）。
const REF = [
  { name: "AAHS.txt", key: "133a50000edefb1ece400c8c6048c08f7aba1f7e7257a59a1dcf653fd3e262ea" },
  { name: "Foo Bar.MD", key: "300b9486bfd0b9ebcfd19df2bcb6f23a12c0703d15051d6a8c89486ed78380c2" },
  { name: "Cafe\u0301.md", key: "76610ba5324ebac79faeb36a2683ed13a261477c7d587e51d8ea340264d25080" },
];
const SHA = "a".repeat(64);
const MODEL = "gemini-3.8-flash-tiered";
const LANG = "简体中文";

describe("与电脑端对拍", () => {
  it.each(REF)("docKey($name)", async ({ name, key }) => {
    expect(await canvasDocKey(name)).toBe(key);
    expect(await canvasDocKey(`canvas/${name}`.slice("canvas/".length))).toBe(key);
  });

  it("缓存文件名", async () => {
    expect(await sharedTranslationFileName(REF[0].key, SHA, LANG, MODEL)).toBe(
      `${REF[0].key}-${SHA}-707ab41cd2a47a55-9937e365aaf3a085.json`,
    );
  });

  it("分段 key = sha256(JSON 串)", async () => {
    const segment = { source: "Hello", kind: "prose", protectedValues: [] } as never;
    const key = await sha256Hex(getSegmentTranslationKey(segment));
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).toBe(await sha256Hex(JSON.stringify({ source: "Hello", kind: "prose", protectedValues: [] })));
  });
});

function record(): CanvasTranslationRecord {
  return {
    name: "AAHS.txt",
    sourceSha: SHA,
    targetLanguage: LANG,
    model: MODEL,
    content: "译文",
    translatedAt: 1_700_000_000_000,
    untranslatedCount: 0,
    segmentTranslationVersion: 1,
    segmentTranslations: [{ key: "b".repeat(64), text: "段" }, { key: "not-hex", text: "x" }],
  };
}

describe("记录往返", () => {
  it("电脑格式往返，过滤非 hex 段 key；任一维度不符返回 null", async () => {
    const shared = toSharedRecord(record(), REF[0].key);
    expect(shared.version).toBe(2);
    const query = { name: "AAHS.txt", docKey: REF[0].key, sourceSha: SHA, model: MODEL, targetLanguage: LANG };
    const back = fromSharedRecord(JSON.stringify(shared), query);
    expect(back?.content).toBe("译文");
    expect(back?.segmentTranslations).toEqual([{ key: "b".repeat(64), text: "段" }]);
    expect(fromSharedRecord(JSON.stringify(shared), { ...query, model: "other" })).toBeNull();
    expect(fromSharedRecord(JSON.stringify(shared), { ...query, sourceSha: "c".repeat(64) })).toBeNull();
    expect(fromSharedRecord(JSON.stringify({ ...shared, version: 1 }), query)).toBeNull();
  });
});

describe("读写流程", () => {
  const target = { baseUrl: "http://sync.example:5974", token: "test-token" };
  const lookup = { sourceSha: SHA, model: MODEL, targetLanguage: LANG, target };

  it("本机有记录时不拉、不调模型", async () => {
    const stored = JSON.stringify(toSharedRecord(record(), REF[0].key));
    const call = vi.fn(async (cmd: string) => (cmd === "canvas_shared_translation_load" ? stored : null)) as never;
    const hit = await loadSharedTranslation("AAHS.txt", lookup, call);
    expect(hit?.content).toBe("译文");
    expect((call as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      "canvas_shared_translation_load",
    ]);
  });

  it("本机没有时向电脑拉一次，404 返回 null", async () => {
    const calls: string[] = [];
    const call = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return cmd === "canvas_shared_translation_pull" ? { status: 404 } : null;
    }) as never;
    expect(await loadSharedTranslation("AAHS.txt", lookup, call)).toBeNull();
    expect(calls).toEqual(["canvas_shared_translation_load", "canvas_shared_translation_pull"]);
  });

  it("保存写电脑格式文件名并推送", async () => {
    const args: Array<[string, Record<string, unknown> | undefined]> = [];
    const call = vi.fn(async (cmd: string, a?: Record<string, unknown>) => {
      args.push([cmd, a]);
      return { status: 200 };
    }) as never;
    const fileName = await saveSharedTranslation(record(), target, call);
    expect(fileName).toBe(`${REF[0].key}-${SHA}-707ab41cd2a47a55-9937e365aaf3a085.json`);
    expect(args.map((a) => a[0])).toEqual(["canvas_shared_translation_save", "canvas_shared_translation_push"]);
  });
});
