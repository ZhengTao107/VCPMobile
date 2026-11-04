-- ptp4g#44：话题置顶进 DB 并参与同步（对齐 VCPChat 话题 DTO 的 pinned）。
-- 线格式与话题哈希只在 pinned=1 时携带该字段，未置顶话题的 configHash 与旧版逐字节一致。
ALTER TABLE topics ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
