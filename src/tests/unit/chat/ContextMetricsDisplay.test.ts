import { describe, expect, it } from 'vitest';
import {
  applyTopicContextMetrics,
  formatCacheMetric,
  formatMessageUsageParts,
  latestRound,
} from '@/core/utils/contextMetricsDisplay';

describe('contextMetricsDisplay（对齐桌面端 localContextMetrics 口径）', () => {
  it('缓存四态与桌面端 formatUpstreamCacheMetric 一致', () => {
    expect(formatCacheMetric({ totalContextTokens: 1 })).toBe('用量未报');
    expect(formatCacheMetric({ totalContextTokens: 1, upstreamUsage: { usageReported: false } })).toBe('用量未报');
    expect(formatCacheMetric({ totalContextTokens: 1, upstreamUsage: { inputTokens: 5 } })).toBe('缓存未报');
    expect(formatCacheMetric({ totalContextTokens: 1, upstreamUsage: { cachedTokens: 0, cacheReported: true } })).toBe('未命中');
    expect(formatCacheMetric({ totalContextTokens: 1, upstreamUsage: { cachedTokens: 12345, cacheReported: true } })).toBe('命中 12,345');
    expect(formatCacheMetric({ totalContextTokens: 1, upstreamUsage: { cached_tokens: 7 } })).toBe('命中 7');
    expect(formatCacheMetric({ totalContextTokens: 1, upstreamUsage: { cachedTokens: 9, cacheReported: false } })).toBe('缓存未报');
  });

  it('取 roundIndex 最大的有效轮次，过滤 totalContextTokens<=0', () => {
    const rounds = [
      { totalContextTokens: 100, roundIndex: 0 },
      { totalContextTokens: 0, roundIndex: 5 },
      { totalContextTokens: 300, roundIndex: 2 },
    ];
    expect(latestRound(rounds)?.roundIndex).toBe(2);
    expect(latestRound('x')).toBeNull();
    expect(latestRound([{ totalContextTokens: -1 }])).toBeNull();
  });

  it('总计 / 缓存 / 附件；无数据不显示，附件为 0 不显示', () => {
    const rounds = [{ totalContextTokens: 20480, roundIndex: 1, upstreamUsage: { cachedTokens: 18000, cacheReported: true } }];
    expect(formatMessageUsageParts(rounds, 765)).toEqual(['总计 20,480 tokens', '命中 18,000', '附件 ≈765']);
    expect(formatMessageUsageParts(rounds, 0)).toEqual(['总计 20,480 tokens', '命中 18,000']);
    expect(formatMessageUsageParts(undefined, 765)).toEqual([]);
    expect(formatMessageUsageParts([], undefined)).toEqual([]);
  });

  it('只把遥测合并到 assistant 消息', () => {
    const messages = [
      { id: 'u', role: 'user' },
      { id: 'a', role: 'assistant' },
    ] as Array<{ id: string; role: string; assistantContextMetricRounds?: any[]; attachmentTokenEstimate?: number }>;
    applyTopicContextMetrics(messages, {
      u: { rounds: [{ totalContextTokens: 1 }] },
      a: { rounds: [{ totalContextTokens: 2 }], attachmentTokenEstimate: 85 },
    });
    expect(messages[0].assistantContextMetricRounds).toBeUndefined();
    expect(messages[1].assistantContextMetricRounds).toEqual([{ totalContextTokens: 2 }]);
    expect(messages[1].attachmentTokenEstimate).toBe(85);
    expect(applyTopicContextMetrics(messages, null)).toBe(messages);
  });
});
