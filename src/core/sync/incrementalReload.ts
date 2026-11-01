/**
 * 同步收尾的刷新决策（ptp4g#26）。
 *
 * Rust 完成事件 summary 携带 pulledTopics / pushedTopics / topicsTruncated：
 * - pushed：本地已是最新，推给桌面即可，界面无需重载；
 * - pulled：从桌面拉回并已落库，只有当前打开的话题在其中才需重载历史。
 * 集合只覆盖消息阶段；元数据阶段（owner/topic）有写入、集合缺失或被截断时一律退回全量重载。
 */
export interface SyncTopicRef {
  ownerType: string;
  ownerId: string;
  topicId: string;
}

export interface SyncTopicSets {
  pulled: SyncTopicRef[];
  pushed: SyncTopicRef[];
  truncated: boolean;
}

export type SyncReloadPlan =
  | { kind: "full" }
  | {
      kind: "incremental";
      invalidateTopicCaches: boolean;
      reloadCurrentOwnerTopics: boolean;
      reloadCurrentHistory: boolean;
    };

const isTopicRef = (value: unknown): value is SyncTopicRef => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref.ownerType === "string" &&
    ref.ownerType.length > 0 &&
    typeof ref.ownerId === "string" &&
    ref.ownerId.length > 0 &&
    typeof ref.topicId === "string" &&
    ref.topicId.length > 0
  );
};

const readTopicList = (value: unknown): SyncTopicRef[] | null =>
  Array.isArray(value) && value.every(isTopicRef)
    ? value.map(({ ownerType, ownerId, topicId }) => ({ ownerType, ownerId, topicId }))
    : null;

/** 从完成事件 summary 读取话题集合；旧版本不带字段或格式不对时返回 null（调用方退回全量）。 */
export function readSyncTopicSets(source: Record<string, unknown>): SyncTopicSets | null {
  const pulled = readTopicList(source.pulledTopics);
  const pushed = readTopicList(source.pushedTopics);
  if (!pulled || !pushed || typeof source.topicsTruncated !== "boolean") return null;
  return { pulled, pushed, truncated: source.topicsTruncated };
}

export function planSyncReload(
  sets: SyncTopicSets | null,
  metadataChanged: boolean,
  current: SyncTopicRef | null,
): SyncReloadPlan {
  if (!sets || sets.truncated || metadataChanged) return { kind: "full" };
  const sameOwner = (topic: SyncTopicRef) =>
    current !== null &&
    topic.ownerType === current.ownerType &&
    topic.ownerId === current.ownerId;
  return {
    kind: "incremental",
    invalidateTopicCaches: sets.pulled.length > 0,
    reloadCurrentOwnerTopics: sets.pulled.some(sameOwner),
    reloadCurrentHistory: sets.pulled.some(
      (topic) => sameOwner(topic) && topic.topicId === current?.topicId,
    ),
  };
}
