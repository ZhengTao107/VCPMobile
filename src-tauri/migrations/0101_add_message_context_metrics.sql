-- ptp4g#14：assistant 消息的上下文用量遥测（对齐 VCPChat assistantContextMetricRounds）。
-- JSON：{"rounds":[contextMetrics...],"attachmentTokenEstimate":N}
-- 本列是本端元数据：不进入消息指纹、不进入同步 wire DTO，pull upsert 不会覆盖它。
ALTER TABLE messages ADD COLUMN context_metrics TEXT;
