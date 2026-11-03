import { invoke } from "@tauri-apps/api/core";
import {
  buildTranslationInstructions,
  interpretTranslationResponse,
  translateDocumentContent,
  TranslationError,
  SEGMENT_TRANSLATION_VERSION,
  type SegmentTranslation,
  type TranslateBatchRequest,
} from "../../core/utils/canvasTranslation";

/** 电脑端 modules/services/canvasTranslationFallback.js:3-4。 */
export const CANVAS_TRANSLATION_MODEL = "gemini-3.8-flash-tiered";
export const CANVAS_TRANSLATION_FALLBACK_MODEL = "gpt-6-luna";
/** 电脑端 Canvasmodules/canvas.js:5831。 */
export const CANVAS_TRANSLATION_TARGET_LANGUAGE = "简体中文";

/** 同电脑端 resolveCanvasTranslationModel：空值与旧名归一到默认模型。 */
export function resolveCanvasTranslationModel(model: unknown) {
  const selected = typeof model === "string" ? model.trim() : "";
  return !selected || selected === "gemini-3.7-flash-tiered" ? CANVAS_TRANSLATION_MODEL : selected;
}

/** 设置里有 canvasTranslationModel / canvasTranslationTargetLanguage 时用之，否则用电脑端默认值。 */
export function translationSettings(settings: unknown) {
  const record = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const language = record.canvasTranslationTargetLanguage;
  return {
    model: resolveCanvasTranslationModel(record.canvasTranslationModel),
    targetLanguage:
      typeof language === "string" && language.trim() ? language.trim() : CANVAS_TRANSLATION_TARGET_LANGUAGE,
  };
}

export interface CanvasTranslationRecord {
  name: string;
  sourceSha: string;
  targetLanguage: string;
  model: string;
  content: string;
  translatedAt: number;
  untranslatedCount: number;
  segmentTranslationVersion: number;
  segmentTranslations: SegmentTranslation[];
}

export function parseTranslationRecord(text: string | null | undefined): CanvasTranslationRecord | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<CanvasTranslationRecord>;
    if (
      typeof value?.sourceSha !== "string" ||
      typeof value.content !== "string" ||
      typeof value.targetLanguage !== "string" ||
      typeof value.model !== "string"
    ) {
      return null;
    }
    return {
      name: typeof value.name === "string" ? value.name : "",
      sourceSha: value.sourceSha,
      targetLanguage: value.targetLanguage,
      model: value.model,
      content: value.content,
      translatedAt: typeof value.translatedAt === "number" ? value.translatedAt : 0,
      untranslatedCount: typeof value.untranslatedCount === "number" ? value.untranslatedCount : 0,
      segmentTranslationVersion: Number(value.segmentTranslationVersion) || 0,
      segmentTranslations: Array.isArray(value.segmentTranslations)
        ? value.segmentTranslations.filter((i) => typeof i?.key === "string" && typeof i?.text === "string")
        : [],
    };
  } catch {
    return null;
  }
}

type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TranslateHttpResponse {
  status: number;
  body: string;
  truncated: boolean;
}

/** Rust 字符串错误 → TranslationError；TranslationError 原样返回。 */
export function toTranslationError(error: unknown): TranslationError {
  if (error instanceof TranslationError) return error;
  if ((error as { name?: string })?.name === "AbortError") {
    return new TranslationError("TRANSLATION_CANCELLED", "翻译已取消。", false);
  }
  const text = error instanceof Error ? error.message : String(error);
  if (text === "CANCELLED") return new TranslationError("TRANSLATION_CANCELLED", "翻译已取消。", false);
  if (/^(TIMEOUT|CONNECT|NETWORK)/.test(text)) {
    return new TranslationError("TRANSLATION_NETWORK_ERROR", "翻译服务连接失败，请检查 VCP 服务和网络。");
  }
  if (text.startsWith("VCP_NOT_CONFIGURED")) {
    return new TranslationError("TRANSLATION_NOT_CONFIGURED", "Canvas 翻译需要已配置的 VCP 地址和 API Key。", false);
  }
  return new TranslationError("TRANSLATION_FAILED", text, false);
}

export const describeTranslationError = (error: unknown) => toTranslationError(error).message;

let requestSeq = 0;

export async function loadCanvasTranslation(name: string, call: Call = invoke) {
  return parseTranslationRecord(await call<string | null>("canvas_translation_load", { name }));
}

export interface RunTranslationOptions {
  name: string;
  content: string;
  sourceSha: string;
  model: string;
  targetLanguage: string;
  previous?: CanvasTranslationRecord | null;
  signal?: AbortSignal;
  onProgress?: (progress: { done: number; total: number }) => void;
  call?: Call;
}

/** 翻译一篇文稿并写入 .translations/<文件名>.json；未改动的段复用 previous。 */
export async function runCanvasTranslation(options: RunTranslationOptions): Promise<CanvasTranslationRecord> {
  const call = options.call ?? invoke;
  const { model, targetLanguage } = options;
  const translateBatch = async (request: TranslateBatchRequest) => {
    const requestId = `canvas-translate-${++requestSeq}-${Date.now()}`;
    const onAbort = () => void Promise.resolve(call("canvas_translate_cancel", { requestId })).catch(() => {});
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await call<TranslateHttpResponse>("canvas_translate_request", {
        requestId,
        model,
        system: buildTranslationInstructions(request),
        user: request.text,
        stream: model === CANVAS_TRANSLATION_FALLBACK_MODEL,
      });
      return interpretTranslationResponse(response);
    } catch (error) {
      throw toTranslationError(error);
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
  };
  const result = await translateDocumentContent(options.content, {
    targetLanguage,
    model,
    translateBatch,
    previousTranslation: options.previous ?? null,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const record: CanvasTranslationRecord = {
    name: options.name,
    sourceSha: options.sourceSha,
    targetLanguage,
    model,
    content: result.content,
    translatedAt: Date.now(),
    untranslatedCount: result.untranslatedCount,
    segmentTranslationVersion: SEGMENT_TRANSLATION_VERSION,
    segmentTranslations: result.segmentTranslations,
  };
  await call("canvas_translation_save", { name: options.name, record: JSON.stringify(record) });
  return record;
}
