import { describe, expect, it } from "vitest";
import {
  planSyncReload,
  readSyncTopicSets,
  type SyncTopicSets,
} from "../../../core/sync/incrementalReload";
import { formatSyncBatchNoticeLabel } from "../../../core/sync/syncForegroundNotice";

const current = { ownerType: "agent", ownerId: "a1", topicId: "t1" };
const sets = (partial: Partial<SyncTopicSets>): SyncTopicSets => ({
  pulled: [],
  pushed: [],
  truncated: false,
  ...partial,
});

describe("readSyncTopicSets", () => {
  it("returns null for legacy summaries without topic sets", () => {
    expect(readSyncTopicSets({ successfulTopics: 1 })).toBeNull();
  });

  it("returns null when an entry is malformed", () => {
    expect(
      readSyncTopicSets({
        pulledTopics: [{ ownerType: "agent", ownerId: "", topicId: "t" }],
        pushedTopics: [],
        topicsTruncated: false,
      }),
    ).toBeNull();
  });

  it("reads well-formed sets and drops extra fields", () => {
    expect(
      readSyncTopicSets({
        pulledTopics: [{ ...current, extra: 1 }],
        pushedTopics: [],
        topicsTruncated: true,
      }),
    ).toEqual({ pulled: [current], pushed: [], truncated: true });
  });
});

describe("planSyncReload", () => {
  it("falls back to full reload when sets are missing, truncated or metadata changed", () => {
    expect(planSyncReload(null, false, current)).toEqual({ kind: "full" });
    expect(planSyncReload(sets({ truncated: true }), false, current)).toEqual({ kind: "full" });
    expect(planSyncReload(sets({}), true, current)).toEqual({ kind: "full" });
  });

  it("does not reload anything for pushed-only runs", () => {
    expect(planSyncReload(sets({ pushed: [current] }), false, current)).toEqual({
      kind: "incremental",
      invalidateTopicCaches: false,
      reloadCurrentOwnerTopics: false,
      reloadCurrentHistory: false,
    });
  });

  it("reloads only the current history when the current topic was pulled", () => {
    expect(planSyncReload(sets({ pulled: [current] }), false, current)).toEqual({
      kind: "incremental",
      invalidateTopicCaches: true,
      reloadCurrentOwnerTopics: true,
      reloadCurrentHistory: true,
    });
  });

  it("refreshes the owner list but keeps history when a sibling topic was pulled", () => {
    const sibling = { ...current, topicId: "t2" };
    expect(planSyncReload(sets({ pulled: [sibling] }), false, current)).toMatchObject({
      reloadCurrentOwnerTopics: true,
      reloadCurrentHistory: false,
    });
  });

  it("only invalidates caches when another owner was pulled", () => {
    const other = { ownerType: "group", ownerId: "g1", topicId: "t9" };
    expect(planSyncReload(sets({ pulled: [other] }), false, current)).toEqual({
      kind: "incremental",
      invalidateTopicCaches: true,
      reloadCurrentOwnerTopics: false,
      reloadCurrentHistory: false,
    });
    expect(planSyncReload(sets({ pulled: [other] }), false, null)).toMatchObject({
      reloadCurrentHistory: false,
    });
  });
});

describe("formatSyncBatchNoticeLabel", () => {
  it("shows the batch position", () => {
    expect(formatSyncBatchNoticeLabel(3, 7)).toBe("VCP 正在同步 · 第 3/7 批");
  });
});
