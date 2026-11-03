/**
 * Canvas 译文三端共用（ptp4g#40）：读写电脑端 `AppData/CanvasTranslations/` 的同款记录。
 *
 * - docKey = sha256(相对 canvas 根的路径：`\`→`/`、去空段与 `.`、NFC、小写、NFC)，同电脑 canvasDocKey.js。
 * - 文件名 = `<docKey>-<sourceHash>-<model16>-<lang16>.json`，同电脑 canvasTranslationCache.cacheFileName。
 * - sourceHash = 正文 sha256（电脑 document.hash 对 UTF-8 正文取 sha256，等于手机 manifest 的 sha256）。
 * - 记录 version 2；电脑端靠 docKey 跨端认领（sameSource），sourcePath 只作占位。
 */
import { invoke } from "@tauri-apps/api/core";
import { sha256Hex } from "../../core/utils/canvasTranslation";
import type { HintTarget } from "../../core/sync/remoteChangeHint";
import type { CanvasTranslationRecord } from "./canvasTranslationRunner";

export const SHARED_TRANSLATION_VERSION = 2;
type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const HEX64 = /^[a-f0-9]{64}$/;

export function normalizeCanvasRelative(name: string): string {
  return String(name)
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/")
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFC");
}

export const canvasDocKey = (name: string) => sha256Hex(normalizeCanvasRelative(name));

export async function sharedTranslationFileName(
  docKey: string,
  sourceHash: string,
  targetLanguage: string,
  model: string,
): Promise<string> {
  const languageKey = (await sha256Hex(targetLanguage)).slice(0, 16);
  const modelKey = model ? `-${(await sha256Hex(model)).slice(0, 16)}` : "";
  return `${docKey}-${sourceHash}${modelKey}-${languageKey}.json`;
}

export function toSharedRecord(record: CanvasTranslationRecord, docKey: string): Record<string, unknown> {
  return {
    version: SHARED_TRANSLATION_VERSION,
    sourcePath: `canvas/${record.name}`,
    docKey,
    sourceHash: record.sourceSha,
    sourceRevision: null,
    targetLanguage: record.targetLanguage,
    model: record.model,
    requestedModel: record.model,
    fallbackReason: "",
    content: record.content,
    translatedCount: 0,
    requestedCount: 0,
    reusedCount: 0,
    untranslatedCount: record.untranslatedCount,
    requests: 0,
    elapsedMs: 0,
    segmentTranslationVersion: record.segmentTranslationVersion,
    segmentTranslations: record.segmentTranslations.filter((item) => HEX64.test(item.key)),
    createdAt: new Date(record.translatedAt || Date.now()).toISOString(),
  };
}

export interface SharedQuery {
  name: string;
  docKey: string;
  sourceSha: string;
  model: string;
  targetLanguage: string;
}

/** 电脑格式记录 → 手机记录；版本、docKey、正文 hash、模型、语言任一不符返回 null。 */
export function fromSharedRecord(text: string | null | undefined, query: SharedQuery): CanvasTranslationRecord | null {
  if (!text) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    value?.version !== SHARED_TRANSLATION_VERSION ||
    value.docKey !== query.docKey ||
    value.sourceHash !== query.sourceSha ||
    value.targetLanguage !== query.targetLanguage ||
    value.model !== query.model ||
    typeof value.content !== "string"
  ) {
    return null;
  }
  const segments = Array.isArray(value.segmentTranslations) ? value.segmentTranslations : [];
  const createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : NaN;
  return {
    name: query.name,
    sourceSha: query.sourceSha,
    targetLanguage: query.targetLanguage,
    model: query.model,
    content: value.content,
    translatedAt: Number.isFinite(createdAt) ? createdAt : 0,
    untranslatedCount: Number.isInteger(value.untranslatedCount) ? (value.untranslatedCount as number) : 0,
    segmentTranslationVersion: Number(value.segmentTranslationVersion) || 0,
    segmentTranslations: segments.filter(
      (item): item is { key: string; text: string } =>
        typeof (item as { key?: unknown })?.key === "string" && typeof (item as { text?: unknown })?.text === "string",
    ),
  };
}

export interface SharedLookup {
  sourceSha: string;
  model: string;
  targetLanguage: string;
  target?: HintTarget | null;
}

/** 先读本机镜像；没有且有同步目标时向电脑拉这一个文件（404 = 电脑也没有）。 */
export async function loadSharedTranslation(
  name: string,
  lookup: SharedLookup,
  call: Call = invoke,
): Promise<CanvasTranslationRecord | null> {
  const docKey = await canvasDocKey(name);
  const fileName = await sharedTranslationFileName(docKey, lookup.sourceSha, lookup.targetLanguage, lookup.model);
  const query: SharedQuery = { name, docKey, ...lookup };
  const local = fromSharedRecord(await call<string | null>("canvas_shared_translation_load", { name: fileName }), query);
  if (local || !lookup.target) return local;
  const pulled = await call<{ status: number }>("canvas_shared_translation_pull", {
    baseUrl: lookup.target.baseUrl,
    token: lookup.target.token,
    name: fileName,
  });
  if (pulled?.status !== 200) return null;
  return fromSharedRecord(await call<string | null>("canvas_shared_translation_load", { name: fileName }), query);
}

/** 写电脑格式记录到本机镜像，有同步目标时推送（电脑已有同名文件回 409，同键视为等价）。 */
export async function saveSharedTranslation(
  record: CanvasTranslationRecord,
  target: HintTarget | null | undefined,
  call: Call = invoke,
): Promise<string> {
  const docKey = await canvasDocKey(record.name);
  const fileName = await sharedTranslationFileName(docKey, record.sourceSha, record.targetLanguage, record.model);
  await call("canvas_shared_translation_save", {
    name: fileName,
    record: JSON.stringify(toSharedRecord(record, docKey)),
  });
  if (target) {
    await call("canvas_shared_translation_push", { baseUrl: target.baseUrl, token: target.token, name: fileName });
  }
  return fileName;
}
