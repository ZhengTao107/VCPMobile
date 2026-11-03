/**
 * 手机 Canvas 翻译（ptp4g#39）：移植自电脑端
 * - modules/services/canvasTranslation.js（分段、占位符保护/还原、复用、批次打包与解析、纠错轮）
 * - modules/services/canvasPmidFormat.js（PMID 引用归一）
 * - modules/services/canvasTranslationTransport.js（JSON/SSE 响应解析与可重试判断）
 * 与电脑端的差异：段 key 先取 JSON 串，再在 translateDocumentContent 里异步取 sha256（与电脑端逐字节一致，ptp4g#40）；
 * 并发默认 4（电脑端注释：SP 实测 12 路触发 429、4 路没有）；表格单元格分支未移植（电脑端表格整体保持原样，从不生成）。
 */

export const TRANSLATION_CONCURRENCY = 4;
export const THROTTLE_DELAYS_MS = [3000, 8000];
export const BATCH_CHARS = 8000;
export const BATCH_MAX_SEGMENTS = 20;
export const RETRY_BATCH_MAX_SEGMENTS = 3;
export const MAX_REQUESTS = 50;
export const SEGMENT_TRANSLATION_VERSION = 1;
const PLACEHOLDER = /__VCP_PROTECTED_\d+__/g;
const BATCH_LINE = /^\s*⟦(\d+)⟧[ \t]?(.*)$/;
const REFERENCE_HEADING =
  /^(?:\*\*|__)?\s*(?:\d+(?:\.\d+)*[.)]?\s+)?(?:references?|reference list|bibliography|literature cited|works cited|参考文献)\s*(?:\*\*|__)?\s*[:：]?$/i;

export class TranslationError extends Error {
  code: string;
  retryable: boolean;
  status?: number;
  constructor(code: string, message: string, retryable = true, status?: number) {
    super(message);
    this.name = "TranslationError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export interface ProtectedValue {
  token: string;
  value: string;
}

export interface TranslationSegment {
  id: string;
  source: string;
  leading: string;
  trailing: string;
  protectedValues: ProtectedValue[];
  lineIndex: number;
  kind: "line";
  prefix: string;
  key?: string;
}

export interface SegmentTranslation {
  key: string;
  text: string;
}

// ---------------------------------------------------------------- 结构识别

const isFenceLine = (line: string) => /^\s*(`{3,}|~{3,})/.test(line);

export function splitMarkdownTableRow(line: string) {
  const source = String(line ?? "");
  const leading = source.match(/^\s*/)?.[0] || "";
  const trailing = source.match(/\s*$/)?.[0] || "";
  const coreEnd = Math.max(leading.length, source.length - trailing.length);
  const core = source.slice(leading.length, coreEnd);
  const delimiters: number[] = [];
  let codeMarkerLength = 0;
  for (let index = 0; index < core.length; ) {
    if (core[index] === "\\") {
      index += Math.min(2, core.length - index);
      continue;
    }
    if (core[index] === "`") {
      let runEnd = index + 1;
      while (core[runEnd] === "`") runEnd += 1;
      const runLength = runEnd - index;
      if (codeMarkerLength === 0) codeMarkerLength = runLength;
      else if (codeMarkerLength === runLength) codeMarkerLength = 0;
      index = runEnd;
      continue;
    }
    if (core[index] === "|" && codeMarkerLength === 0) delimiters.push(index);
    index += 1;
  }
  if (delimiters.length === 0) return null;
  const hasLeadingPipe = delimiters[0] === 0;
  const hasTrailingPipe = delimiters[delimiters.length - 1] === core.length - 1;
  const innerStart = hasLeadingPipe ? 1 : 0;
  const innerEnd = hasTrailingPipe ? core.length - 1 : core.length;
  const cells: string[] = [];
  let cellStart = innerStart;
  for (const delimiter of delimiters.filter((p) => p >= innerStart && p < innerEnd)) {
    cells.push(core.slice(cellStart, delimiter));
    cellStart = delimiter + 1;
  }
  cells.push(core.slice(cellStart, innerEnd));
  return { leading, trailing, hasLeadingPipe, hasTrailingPipe, cells };
}

function isTableSeparator(line: string) {
  const row = splitMarkdownTableRow(line);
  return Boolean(row && row.cells.length >= 2 && row.cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell)));
}

function splitLineStructure(line: string) {
  const match = String(line).match(
    /^(\s*(?:(?:>\s*)+)?(?:(?:#{1,6})\s+|(?:[-+*]|\d+[.)])\s+|(?:[-+*]\s+)?\[[ xX]\]\s+|\[[^\]\r\n]+\]:\s+)?)(.*)$/,
  );
  return match ? { prefix: match[1], body: match[2] } : { prefix: "", body: String(line) };
}

/** 保护 PMID 引用标记与转义方括号，模型不能改动 PMID 数字与分组。 */
export function protectInlineSyntax(text: string) {
  const protectedValues: ProtectedValue[] = [];
  const protect = (value: string) => {
    const token = `__VCP_PROTECTED_${protectedValues.length}__`;
    protectedValues.push({ token, value });
    return token;
  };
  let protectedText = String(text).replace(
    /\\?\[(?:PMID\s*:?\s*)?\d{6,9}(?:(?:\s*[,;，、]\s*|\s+PMID\s*:?\s*)(?:PMID\s*:?\s*)?\d{6,9})*\\?\]/gi,
    (value) => protect(value),
  );
  protectedText = protectedText.replace(/\\[[\]]/g, (value) => protect(value));
  return { text: protectedText, protectedValues };
}

/** 按占位符名还原：模型可按目标语序挪动占位符，引用不会错位。 */
export function restoreInlineSyntax(text: string | undefined, protectedValues: ProtectedValue[]) {
  let restored = String(text ?? "");
  for (const item of protectedValues || []) restored = restored.split(item.token).join(item.value);
  return restored;
}

function createSegment(id: string, text: string, protectedValues: ProtectedValue[], lineIndex: number, prefix: string) {
  const source = String(text ?? "");
  const leading = source.match(/^\s*/)?.[0] || "";
  const trailing = source.match(/\s*$/)?.[0] || "";
  const coreEnd = Math.max(leading.length, source.length - trailing.length);
  const core = source.slice(leading.length, coreEnd);
  if (!core.trim()) return null;
  const segment: TranslationSegment = { id, source: core, leading, trailing, protectedValues, lineIndex, kind: "line", prefix };
  return segment;
}

/** 逐行分段：跳过 front matter、代码围栏、分隔线、HTML 注释、表格与参考文献条目（标题本身照译）。 */
export function buildTranslationSegments(content: string): TranslationSegment[] {
  const segments: TranslationSegment[] = [];
  const lines = String(content ?? "").split("\n");
  const tableLines = new Set<number>();
  for (let index = 1; index < lines.length; index += 1) {
    if (!isTableSeparator(lines[index])) continue;
    const header = splitMarkdownTableRow(lines[index - 1]);
    if (!header || header.cells.length < 2) continue;
    tableLines.add(index - 1);
    tableLines.add(index);
    for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
      const row = splitMarkdownTableRow(lines[rowIndex]);
      if (!row || row.cells.length < 2) break;
      tableLines.add(rowIndex);
    }
  }
  let frontMatterEnd = -1;
  if (lines[0]?.replace(/^\uFEFF/, "").trim() === "---") {
    const closingOffset = lines.slice(1).findIndex((line) => /^(?:---|\.\.\.)\s*$/.test(line.trim()));
    if (closingOffset >= 0) frontMatterEnd = closingOffset + 1;
  }
  let fence: string | null = null;
  let htmlComment = false;
  let segmentIndex = 0;
  let referenceLevel: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index <= frontMatterEnd) continue;
    if (isFenceLine(line)) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]?.[0] ?? null;
      fence = fence ? (fence === marker ? null : fence) : marker;
      continue;
    }
    if (fence || isTableSeparator(line) || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) continue;
    if (htmlComment) {
      if (line.includes("-->")) htmlComment = false;
      continue;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) htmlComment = true;
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      if (referenceLevel !== null && level > referenceLevel) continue;
      referenceLevel = REFERENCE_HEADING.test(heading[2]) ? level : null;
    } else if (referenceLevel !== null) {
      continue;
    }
    if (tableLines.has(index)) continue;

    const { prefix, body } = splitLineStructure(line);
    const protectedBody = protectInlineSyntax(body);
    const segment = createSegment(`s${segmentIndex++}`, protectedBody.text, protectedBody.protectedValues, index, prefix);
    if (segment) segments.push(segment);
  }
  return segments;
}

export function reconstructTranslatedContent(
  content: string,
  segments: TranslationSegment[],
  translations: Map<string, string>,
) {
  const lines = String(content ?? "").split("\n");
  for (const segment of segments) {
    const translated = restoreInlineSyntax(translations.get(segment.id), segment.protectedValues);
    lines[segment.lineIndex] = `${segment.prefix}${segment.leading}${translated}${segment.trailing}`;
  }
  return lines.join("\n");
}

export const getSegmentTranslationKey = (segment: TranslationSegment) =>
  JSON.stringify({ source: segment.source, kind: segment.kind, protectedValues: segment.protectedValues });

/** UTF-8 sha256 十六进制；与电脑端 crypto.createHash('sha256') 一致。 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text ?? "")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- 译文校验

const MAX_TRANSLATION_RATIO = 4;
const MAX_TRANSLATION_SLACK = 40;
export function isValidTranslation(segment: TranslationSegment, text: unknown): text is string {
  if (typeof text !== "string" || !text.trim() || /[\r\n]/.test(text)) return false;
  if (text.length > String(segment.source ?? "").length * MAX_TRANSLATION_RATIO + MAX_TRANSLATION_SLACK) return false;
  const expected = segment.protectedValues.map((item) => item.token).sort().join();
  const returned = (text.match(PLACEHOLDER) || []).sort().join();
  return expected === returned;
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const CHINESE_TARGET = /中文|汉语|chinese|^zh\b/i;
const LOCATION_LINE = /^[\s>]*(?:[-*]\s+)?\*{0,2}Locations?\s*:?\s*\*{0,2}\s*:?/i;
const REFERENCE_MAX_CHARS = 400;
const REFERENCE_LIKE = [/\bet al\./, /\bdoi[:.\s]/i, /^\s*(?:\d+\\?[.)]\s*)?[A-Z][A-Za-z'’-]+ [A-Z]{1,3}(?:,|\.|$)/];

function plainSourceText(segment: TranslationSegment) {
  return String(segment.source ?? "")
    .replace(PLACEHOLDER, " ")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+|\S+@\S+\.[A-Za-z]{2,}/g, " ")
    .replace(/[*_`#>]/g, " ")
    .trim();
}

const isReferenceLike = (text: string) => REFERENCE_LIKE.some((pattern) => pattern.test(text));

/** 原样返回是否可接受：引用、数字、Location 行立即可以；其他短文本重试一次后可以；目标为中文时英文正文永不可以。 */
export function echoAcceptable(segment: TranslationSegment, targetLanguage: string, retry: boolean) {
  if (LOCATION_LINE.test(String(segment.source ?? ""))) return true;
  const text = plainSourceText(segment);
  if (!/[A-Za-z]{3,}/.test(text)) return true;
  if (text.length <= REFERENCE_MAX_CHARS && isReferenceLike(text)) return true;
  if (!retry) return false;
  const prose = !CJK.test(text) && (text.match(/\b[a-z]{3,}\b/g) || []).length >= 3;
  return !(prose && CHINESE_TARGET.test(String(targetLanguage ?? "")));
}

export function isEchoReply(segment: TranslationSegment, text: unknown, targetLanguage: string) {
  if (typeof text !== "string") return false;
  if (text === segment.source) return true;
  if (!CHINESE_TARGET.test(String(targetLanguage ?? ""))) return false;
  return !CJK.test(plainSourceText(segment)) && !CJK.test(text.replace(PLACEHOLDER, " "));
}

export interface PreviousTranslation {
  segmentTranslationVersion?: number;
  targetLanguage?: string;
  model?: string;
  segmentTranslations?: SegmentTranslation[];
}

function reusableTranslations(previous: PreviousTranslation | null, targetLanguage: string, model: string) {
  const reusable = new Map<string, string>();
  if (
    previous?.segmentTranslationVersion !== SEGMENT_TRANSLATION_VERSION ||
    previous.targetLanguage !== targetLanguage ||
    previous.model !== model
  ) {
    return reusable;
  }
  for (const item of previous.segmentTranslations || []) {
    if (typeof item?.key === "string" && typeof item?.text === "string") reusable.set(item.key, item.text);
  }
  return reusable;
}

// ---------------------------------------------------------------- 批次

export function packBatches<T extends { source: string }>(segments: T[], charBudget = BATCH_CHARS, maxSegments = BATCH_MAX_SEGMENTS) {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const segment of segments) {
    if (current.length > 0 && (size + segment.source.length > charBudget || current.length >= maxSegments)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += segment.source.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export const formatBatchText = (sources: string[]) =>
  sources.map((source, index) => `⟦${index + 1}⟧ ${source}`).join("\n");

/** 每个请求行一项；缺失、重复或折行的行为 null。首个编号前的前言和空行忽略。 */
export function parseBatchText(text: string, count: number): Array<string | null> {
  const lines = new Map<number, string>();
  const broken = new Set<number>();
  let current: number | null = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(BATCH_LINE);
    if (match) {
      current = Number(match[1]);
      if (lines.has(current)) broken.add(current);
      lines.set(current, match[2].trim());
    } else if (line.trim() && current !== null) {
      broken.add(current);
    }
  }
  if (count === 1 && lines.size === 0) {
    const plain = String(text ?? "").trim();
    return [plain && !/[\r\n]/.test(plain) ? plain : null];
  }
  return Array.from({ length: count }, (_, index) =>
    broken.has(index + 1) ? null : (lines.get(index + 1) ?? null),
  );
}

export function buildTranslationInstructions({
  targetLanguage,
  segmentCount = 1,
  retry = false,
  insist = false,
}: {
  targetLanguage: string;
  segmentCount?: number;
  retry?: boolean;
  insist?: boolean;
}) {
  return [
    `你是学术稿件翻译器，把用户提供的文本逐行译成${targetLanguage}。`,
    `文本共 ${segmentCount} 行，每行以 ⟦编号⟧ 开头，各行相互独立。每行译文占一行并保留行首编号，不合并、拆分或省略任何一行。只输出译文行，不要前言、解释或代码围栏。`,
    "必须翻译：正文、标题、图表注、审稿意见与作者回复、引号内的引文，以及行首标签（如 Comment、Response）连同其后的内容。不得因为某行是引文、原稿摘录或篇幅较长而保留原文。",
    "保持原样：人名（作者署名、审稿人姓名）按原拼写保留，不音译、不意译；邮箱、网址、DOI、编号、基因与蛋白符号、缩写、数字、单位、统计量、代码，以及形如 __VCP_PROTECTED_0__ 的占位符逐字保留。只由这类内容组成的行，原样输出。",
    "忠实：每行句子数量与原文一致；保持标点的类型、数量与顺序，不为润色改动标点；不删节、总结或补写；上调/下调、增加/减少、处理/对照等方向关系不得颠倒。",
    "输出前逐行核对：凡是含可翻译词句的行，译文中不得残留整句原文。",
    ...(insist
      ? [
          `硬性要求：上一次这些行原样返回了原文。每一行都必须译成${targetLanguage}，不允许原样返回原文或只改动标点、空格；引号内的引文、行首标签及其后的内容同样必须翻译。行内人名仍按原拼写保留，不音译。`,
        ]
      : retry
        ? ["上一次这些行没有译成目标语言或格式不合格，请逐行译出，保留行首编号和占位符。"]
        : []),
  ].join("\n");
}

// ---------------------------------------------------------------- 文档翻译

export interface TranslateBatchRequest {
  text: string;
  items: string[];
  segmentCount: number;
  targetLanguage: string;
  model: string;
  retry: boolean;
  insist: boolean;
  signal: AbortSignal;
}

export interface TranslateOptions {
  targetLanguage: string;
  model?: string;
  translateBatch: (request: TranslateBatchRequest) => Promise<string>;
  previousTranslation?: PreviousTranslation | null;
  concurrency?: number;
  batchChars?: number;
  batchSegments?: number;
  maxRequests?: number;
  throttleDelaysMs?: number[];
  signal?: AbortSignal;
  onProgress?: (progress: { done: number; total: number }) => void;
}

export interface TranslationResult {
  targetLanguage: string;
  model: string;
  content: string;
  translatedCount: number;
  requestedCount: number;
  reusedCount: number;
  untranslatedCount: number;
  requests: number;
  throttledRetries: number;
  elapsedMs: number;
  segmentTranslationVersion: number;
  segmentTranslations: SegmentTranslation[];
}

const cancelledError = () => new TranslationError("TRANSLATION_CANCELLED", "翻译已取消。", false);

function linkSignals(outer: AbortSignal | undefined, inner: AbortSignal) {
  if (!outer) return inner;
  const linked = new AbortController();
  const forward = (source: AbortSignal) => () => linked.abort(source.reason);
  if (outer.aborted) linked.abort(outer.reason);
  else if (inner.aborted) linked.abort(inner.reason);
  else {
    outer.addEventListener("abort", forward(outer), { once: true });
    inner.addEventListener("abort", forward(inner), { once: true });
  }
  return linked.signal;
}

/**
 * 未变的段复用上次译文；待译段打包成编号小批次并行请求；格式不合格或原样返回的行进入一轮纠错，
 * 用首轮剩下的请求预算。仍失败的段保留原文、不进缓存。不可重试的错误（取消、鉴权、缺模型）或全部失败时整篇抛错。
 */
export async function translateDocumentContent(content: string, options: TranslateOptions): Promise<TranslationResult> {
  const {
    targetLanguage,
    model = "",
    translateBatch,
    previousTranslation = null,
    concurrency = TRANSLATION_CONCURRENCY,
    batchChars = BATCH_CHARS,
    batchSegments = BATCH_MAX_SEGMENTS,
    maxRequests = MAX_REQUESTS,
    throttleDelaysMs = THROTTLE_DELAYS_MS,
    signal,
    onProgress,
  } = options;
  const startedAt = Date.now();
  if (typeof translateBatch !== "function") throw new Error("缺少翻译模型请求器。");
  const segments = buildTranslationSegments(content);
  const reusable = reusableTranslations(previousTranslation, targetLanguage, model);
  const translated = new Map<string, string>();
  const pending = new Map<string, TranslationSegment>();
  for (const segment of segments) {
    segment.key = await sha256Hex(getSegmentTranslationKey(segment));
    const cached = reusable.get(segment.key);
    const staleEcho = isEchoReply(segment, cached, targetLanguage) && !echoAcceptable(segment, targetLanguage, true);
    if (!staleEcho && isValidTranslation(segment, cached)) translated.set(segment.key, cached);
    else if (!pending.has(segment.key)) pending.set(segment.key, segment);
  }

  const controller = new AbortController();
  const jobSignal = linkSignals(signal, controller.signal);
  const throwIfAborted = () => {
    if (jobSignal.aborted) throw jobSignal.reason instanceof Error ? jobSignal.reason : cancelledError();
  };
  let requests = 0;
  let throttledRetries = 0;
  let lastError: unknown = null;
  let limit = Math.max(1, Math.floor(concurrency) || 1);
  let unsent = 0;
  const progress = { done: 0, total: 0 };

  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      jobSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(jobSignal.reason instanceof Error ? jobSignal.reason : cancelledError());
        },
        { once: true },
      );
    });

  const proseEchoes = new Set<string>();

  async function requestBatch(batch: TranslationSegment[], retry: boolean) {
    const sources = batch.map((segment) => segment.source);
    const insist = retry && batch.every((segment) => proseEchoes.has(segment.key!));
    let response = "";
    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted();
      requests += 1;
      const startedLimit = limit;
      try {
        response = await translateBatch({
          text: formatBatchText(sources),
          items: sources,
          segmentCount: batch.length,
          targetLanguage,
          model,
          retry,
          insist,
          signal: jobSignal,
        });
        break;
      } catch (error) {
        const failure = error as { retryable?: boolean; status?: number };
        if (failure?.retryable !== true || jobSignal.aborted) throw error;
        if (failure.status === 429) {
          if (startedLimit === limit) limit = Math.max(1, Math.floor(limit / 2));
          if (attempt < throttleDelaysMs.length && requests + unsent < maxRequests) {
            throttledRetries += 1;
            await wait(throttleDelaysMs[attempt]);
            continue;
          }
        }
        lastError = error;
        return batch;
      }
    }
    const texts = parseBatchText(response, batch.length);
    return batch.filter((segment, index) => {
      const text = texts[index];
      if (!isValidTranslation(segment, text)) return true;
      if (isEchoReply(segment, text, targetLanguage) && !echoAcceptable(segment, targetLanguage, retry)) {
        if (!echoAcceptable(segment, targetLanguage, true)) proseEchoes.add(segment.key!);
        return true;
      }
      translated.set(segment.key!, text);
      return false;
    });
  }

  async function runRound(batches: TranslationSegment[][], retry: boolean) {
    const rejected: TranslationSegment[] = [];
    let next = 0;
    unsent = batches.length;
    const workers = Math.min(batches.length, limit);
    await Promise.all(
      Array.from({ length: workers }, async (_, slot) => {
        while (next < batches.length && !jobSignal.aborted && slot < limit) {
          const batch = batches[next++];
          unsent -= 1;
          try {
            rejected.push(...(await requestBatch(batch, retry)));
          } catch (error) {
            controller.abort(error);
            throw error;
          }
          progress.done += 1;
          onProgress?.({ ...progress });
        }
      }),
    );
    throwIfAborted();
    return rejected;
  }

  const queue = [...pending.values()];
  const firstBatches = queue.length > 0 ? packBatches(queue, batchChars, batchSegments) : [];
  progress.total = firstBatches.length;
  onProgress?.({ ...progress });
  const rejected = await runRound(firstBatches, false);
  const budget = Math.max(0, Math.floor(maxRequests) - requests);
  const retrySegments = Math.min(
    batchSegments,
    Math.max(RETRY_BATCH_MAX_SEGMENTS, budget > 0 ? Math.ceil(rejected.length / budget) : batchSegments),
  );
  const groups = [
    rejected.filter((segment) => proseEchoes.has(segment.key!)),
    rejected.filter((segment) => !proseEchoes.has(segment.key!)),
  ];
  const packRetry = (chars: number) =>
    groups.flatMap((group) => (group.length > 0 ? packBatches(group, chars, retrySegments) : []));
  let retryBatches = packRetry(Math.max(1, Math.floor(batchChars / 2)));
  if (retryBatches.length > budget) retryBatches = packRetry(batchChars);
  const retried = retryBatches.slice(0, budget);
  progress.total += retried.length;
  const stillRejected = [
    ...(retried.length > 0 ? await runRound(retried, true) : []),
    ...retryBatches.slice(budget).flat(),
  ];
  const failed = new Set(stillRejected.map((segment) => segment.key!));
  if (queue.length > 0 && failed.size === queue.length) {
    throw (
      lastError ||
      new TranslationError("TRANSLATION_INVALID_OUTPUT", `翻译模型对全部 ${queue.length} 段都没有返回合格译文。`)
    );
  }

  const reusedCount = segments.filter((segment) => !pending.has(segment.key!)).length;
  const untranslatedCount = segments.filter((segment) => failed.has(segment.key!)).length;
  const translations = new Map(
    segments.map((segment) => [
      segment.id,
      failed.has(segment.key!) ? segment.source : (translated.get(segment.key!) ?? segment.source),
    ]),
  );
  return {
    targetLanguage,
    model,
    content: normalizePmidCitationMarkers(reconstructTranslatedContent(content, segments, translations)),
    translatedCount: segments.length - untranslatedCount,
    requestedCount: segments.length - reusedCount,
    reusedCount,
    untranslatedCount,
    requests,
    throttledRetries,
    elapsedMs: Date.now() - startedAt,
    segmentTranslationVersion: SEGMENT_TRANSLATION_VERSION,
    segmentTranslations: [...translated].map(([key, text]) => ({ key, text })),
  };
}

// ---------------------------------------------------------------- PMID 归一（canvasPmidFormat.js）

const PMID_COMPONENT = "(?:PMID\\s*:?\\s*)?[0-9]+";
const PMID_SEPARATOR = "(?:\\s*[,;，、]\\s*|\\s+PMID\\s*:?[ \\t]*)";
const BRACKETED_PMID_PATTERN = new RegExp(
  `\\\\?\\[\\s*${PMID_COMPONENT}(?:${PMID_SEPARATOR}${PMID_COMPONENT})*\\s*\\\\?\\]`,
  "gi",
);
const BARE_PMID_PATTERN = /\bPMID\s*:?\s*[0-9]{6,9}\b/gi;
const PMID_MARKER_PATTERN = new RegExp(`${BRACKETED_PMID_PATTERN.source}|${BARE_PMID_PATTERN.source}`, "gi");

function maskRange(characters: string[], start: number, end: number) {
  for (let index = Math.max(0, start); index < Math.min(characters.length, end); index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
  }
}

function maskRegexMatches(characters: string[], regex: RegExp) {
  const source = characters.join("");
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    maskRange(characters, match.index, match.index + match[0].length);
    if (match[0].length === 0) regex.lastIndex += 1;
  }
}

function maskMarkdownNonCitationRegions(markdown: string) {
  const source = String(markdown || "");
  const characters = source.split("");
  const frontmatter = source.match(
    /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)[\s\S]*?(?:\r\n|\n|\r)(?:---|\.\.\.)[ \t]*(?=\r\n|\n|\r|$)/,
  );
  if (frontmatter) maskRange(characters, 0, frontmatter[0].length);
  const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  let fence: { marker: string; length: number } | null = null;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = linePattern.exec(source))) {
    if (lineMatch[0].length === 0) break;
    const line = lineMatch[0].replace(/(?:\r\n|\n|\r)$/, "");
    if (!fence) {
      const opener = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      if (opener) {
        fence = { marker: opener[1][0], length: opener[1].length };
        maskRange(characters, lineMatch.index, lineMatch.index + lineMatch[0].length);
      }
    } else {
      maskRange(characters, lineMatch.index, lineMatch.index + lineMatch[0].length);
      const closer = new RegExp(`^[ \\t]{0,3}${fence.marker}{${fence.length},}[ \\t]*$`);
      if (closer.test(line)) fence = null;
    }
  }
  maskRegexMatches(characters, /<!--[\s\S]*?(?:-->|$)/g);
  maskRegexMatches(characters, /<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi);
  maskRegexMatches(characters, /(`+)[^\r\n]*?\1/g);
  return characters.join("");
}

interface CitationMatch {
  start: number;
  end: number;
  pmids: string[];
}

function collectCitationMatches(source: string, searchable: string) {
  PMID_MARKER_PATTERN.lastIndex = 0;
  const matches: CitationMatch[] = [...searchable.matchAll(PMID_MARKER_PATTERN)]
    .map((match) => {
      const values = match[0].match(/[0-9]+/g) || [];
      return {
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        pmids: values.filter((v) => /^\d{6,9}$/.test(v)),
        invalid: values.filter((v) => !/^\d{6,9}$/.test(v)),
      };
    })
    .filter((m) => m.pmids.length > 0 && m.invalid.length === 0 && source.slice(m.start, m.end))
    .map(({ start, end, pmids }) => ({ start, end, pmids }));
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const nonOverlapping: CitationMatch[] = [];
  for (const match of matches) {
    const previous = nonOverlapping[nonOverlapping.length - 1];
    if (previous && match.start < previous.end) continue;
    nonOverlapping.push(match);
  }
  return nonOverlapping;
}

const caretWrapped = (source: string, start: number, end: number) => source[start - 1] === "^" && source[end] === "^";

function applyCitationNormalization(source: string, matches: CitationMatch[]) {
  let normalized = "";
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const first = matches[index];
    let start = first.start;
    let end = first.end;
    if (caretWrapped(source, start, end) && start - 1 >= cursor) {
      start -= 1;
      end += 1;
    }
    const pmids = [...first.pmids];
    let nextIndex = index + 1;
    while (nextIndex < matches.length) {
      const next = matches[nextIndex];
      const wrapped = caretWrapped(source, next.start, next.end);
      const nextStart = wrapped ? next.start - 1 : next.start;
      if (!/^[ \t]*(?:[,;，、][ \t]*)?$/.test(source.slice(end, nextStart))) break;
      pmids.push(...next.pmids);
      end = wrapped ? next.end + 1 : next.end;
      nextIndex += 1;
    }
    normalized += source.slice(cursor, start) + `[PMID: ${pmids.join(", ")}]`;
    cursor = end;
    index = nextIndex - 1;
  }
  return normalized + source.slice(cursor);
}

export function normalizePmidCitationMarkers(markdown: string) {
  const source = String(markdown || "");
  return applyCitationNormalization(source, collectCitationMatches(source, maskMarkdownNonCitationRegions(source)));
}

// ---------------------------------------------------------------- 响应解析（canvasTranslationTransport.js）

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = any;

function extractAssistantText(payload: Payload): string {
  const choice = payload?.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new TranslationError("TRANSLATION_OUTPUT_TRUNCATED", "翻译模型输出达到长度上限，译文不完整。");
  }
  const content = choice?.message?.content ?? choice?.text ?? payload?.output_text;
  const text = Array.isArray(content)
    ? content.map((part: Payload) => (typeof part?.text === "string" ? part.text : "")).join("")
    : content;
  if (typeof text === "string" && text.trim()) return text;
  throw new TranslationError("TRANSLATION_EMPTY_RESPONSE", "翻译服务没有返回文本内容。");
}

function parseStream(value: string): Payload {
  let content = "";
  let finishReason: string | null = null;
  let done = false;
  for (const event of value.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      break;
    }
    const payload = JSON.parse(data);
    if (payload.error) return payload;
    if (/^event:\s*error\s*$/m.test(event)) return { error: { message: payload.message || "流式翻译服务返回错误。" } };
    const choice = payload.choices?.[0];
    if (typeof choice?.delta?.content === "string") content += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  if (!done && !finishReason) {
    throw new TranslationError("TRANSLATION_STREAM_INCOMPLETE", "翻译流在完成前中断，未保存不完整译文。");
  }
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

/** 把 Rust canvas_translate_request 的 {status, body, truncated} 解析为模型文本，失败时抛 TranslationError。 */
export function interpretTranslationResponse(response: { status: number; body: string; truncated?: boolean }) {
  if (response.truncated) {
    throw new TranslationError("TRANSLATION_INVALID_RESPONSE", "翻译服务响应超过大小上限。");
  }
  const ok = response.status >= 200 && response.status < 300;
  const text = String(response.body ?? "").replace(/^\uFEFF/, "");
  let payload: Payload = null;
  try {
    payload = ok && /^data:/m.test(text) ? parseStream(text) : JSON.parse(text);
  } catch (error) {
    if (error instanceof TranslationError) throw error;
    if (ok) throw new TranslationError("TRANSLATION_INVALID_RESPONSE", "翻译服务返回了无效 JSON，响应可能不完整。");
  }
  if (!ok || payload?.error) {
    const detail = payload?.error?.message || payload?.message || text.slice(0, 200) || "非 JSON 错误响应";
    throw new TranslationError(
      "TRANSLATION_HTTP_ERROR",
      `翻译服务请求失败 (${response.status}): ${String(detail).slice(0, 500)}`,
      RETRYABLE_STATUS.has(response.status),
      response.status,
    );
  }
  return extractAssistantText(payload);
}
