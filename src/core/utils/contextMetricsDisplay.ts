/**
 * 气泡底部的用量摘要，口径对齐 VCPChat 桌面端 modules/renderer/localContextMetrics.js：
 * - 总计 = 最新一轮 contextMetrics.totalContextTokens（后端已按上游 prompt 总量校准）
 * - 缓存 = upstreamUsage.cachedTokens，按 usageReported/cacheReported 区分 命中/未命中/未报
 * - 附件 = 手机端对实际请求 messages 套用桌面端 vcpClient.js 估算（桌面端不展示此项）
 * 无可用轮次时返回空数组，调用方据此不渲染。
 */

export interface UpstreamUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cached_tokens?: number;
  usageReported?: boolean;
  cacheReported?: boolean;
}

export interface ContextMetricsRound {
  totalContextTokens: number;
  roundIndex?: number;
  upstreamUsage?: UpstreamUsageMetrics | null;
  [key: string]: unknown;
}

export interface MessageContextMetricsPayload {
  rounds?: ContextMetricsRound[];
  attachmentTokenEstimate?: number;
}

const formatNumber = (value: number) => Math.round(value).toLocaleString("en-US");

function isCacheReported(usage: UpstreamUsageMetrics): boolean {
  if (usage.cacheReported === true) return true;
  if (usage.cacheReported !== undefined) return false;
  return Object.prototype.hasOwnProperty.call(usage, "cachedTokens")
    || Object.prototype.hasOwnProperty.call(usage, "cached_tokens");
}

export function formatCacheMetric(round: ContextMetricsRound): string {
  const usage = round.upstreamUsage;
  if (!usage || usage.usageReported === false) return "用量未报";
  if (!isCacheReported(usage)) return "缓存未报";
  const raw = usage.cachedTokens ?? usage.cached_tokens;
  const cached = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(cached) || cached < 0) return "缓存未报";
  return cached > 0 ? `命中 ${formatNumber(cached)}` : "未命中";
}

export function latestRound(rounds: unknown): ContextMetricsRound | null {
  if (!Array.isArray(rounds)) return null;
  let best: ContextMetricsRound | null = null;
  for (const round of rounds) {
    const total = Number((round as ContextMetricsRound)?.totalContextTokens);
    if (!Number.isFinite(total) || total <= 0) continue;
    const index = Math.max(0, Math.floor(Number((round as ContextMetricsRound).roundIndex) || 0));
    const bestIndex = best ? Math.max(0, Math.floor(Number(best.roundIndex) || 0)) : -1;
    if (index >= bestIndex) best = round as ContextMetricsRound;
  }
  return best;
}

export function formatMessageUsageParts(
  rounds: unknown,
  attachmentTokenEstimate?: number,
): string[] {
  const round = latestRound(rounds);
  if (!round) return [];
  const parts = [
    `总计 ${formatNumber(Number(round.totalContextTokens))} tokens`,
    formatCacheMetric(round),
  ];
  const attachments = Number(attachmentTokenEstimate);
  if (Number.isFinite(attachments) && attachments > 0) {
    parts.push(`附件 ≈${formatNumber(attachments)}`);
  }
  return parts;
}

/** 把 get_topic_context_metrics 的结果合并到消息上（只写本端元数据字段）。 */
export function applyTopicContextMetrics<
  T extends { id: string; role: string; assistantContextMetricRounds?: ContextMetricsRound[]; attachmentTokenEstimate?: number },
>(messages: T[], metrics: Record<string, MessageContextMetricsPayload> | null | undefined): T[] {
  if (!metrics) return messages;
  for (const message of messages) {
    const payload = metrics[message.id];
    if (!payload || message.role !== "assistant") continue;
    if (Array.isArray(payload.rounds)) message.assistantContextMetricRounds = payload.rounds;
    if (typeof payload.attachmentTokenEstimate === "number") {
      message.attachmentTokenEstimate = payload.attachmentTokenEstimate;
    }
  }
  return messages;
}
