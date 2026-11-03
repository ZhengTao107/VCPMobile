import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import {
  useChatSessionStore,
  type ConversationKey,
  type ConversationOwnerType,
} from "./chatSessionStore";
import { useTopicStore } from "./topicListManager";
import { useAssistantStore } from "./assistant";

export type OpenTabRef = Pick<ConversationKey, "ownerId" | "ownerType" | "topicId">;

export interface OpenTab extends OpenTabRef {
  /** 话题名；话题列表未加载到时沿用上次已知值，最差回退 topicId。 */
  title: string;
  ownerName: string;
  avatarColor: string | null;
  unread: boolean;
}

/** 与 chatStreamStore.conversationMapKey 同构。 */
export const openTabKey = (tab: OpenTabRef) =>
  JSON.stringify([tab.ownerType, tab.ownerId, tab.topicId]);

const isOwnerType = (value: unknown): value is ConversationOwnerType =>
  value === "agent" || value === "group";
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** 校验持久化数据：丢弃身份不完整的条目，按身份去重并保持原顺序。 */
export const normalizeOpenTabs = (value: unknown): OpenTab[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: OpenTab[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (
      !isNonEmptyString(record.ownerId) ||
      !isOwnerType(record.ownerType) ||
      !isNonEmptyString(record.topicId)
    ) {
      continue;
    }
    const tab: OpenTab = {
      ownerId: record.ownerId,
      ownerType: record.ownerType,
      topicId: record.topicId,
      title: isNonEmptyString(record.title) ? record.title : record.topicId,
      ownerName: typeof record.ownerName === "string" ? record.ownerName : "",
      avatarColor: typeof record.avatarColor === "string" ? record.avatarColor : null,
      unread: record.unread === true,
    };
    const key = openTabKey(tab);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tab);
  }
  return result;
};

/** Canvas 文稿标签（ptp4g#39b）：键为 scoped 路径 `canvas/<文件名>`。与聊天标签分开存放，不进三端上报（Hub 只收 agent/group）。 */
export const CANVAS_SCOPE_PREFIX = "canvas/";
export interface CanvasOpenTab {
  kind: "canvas";
  path: string;
  name: string;
}
export type CanvasTabRef = Pick<CanvasOpenTab, "kind" | "path">;
export const canvasPathOf = (name: string) => `${CANVAS_SCOPE_PREFIX}${name}`;
export const canvasNameOf = (path: string) =>
  path.startsWith(CANVAS_SCOPE_PREFIX) ? path.slice(CANVAS_SCOPE_PREFIX.length) : "";
export const canvasTabKey = (path: string) => JSON.stringify(["canvas", path]);
export const isCanvasTarget = (value: unknown): value is CanvasTabRef =>
  !!value &&
  typeof value === "object" &&
  (value as { kind?: unknown }).kind === "canvas" &&
  typeof (value as { path?: unknown }).path === "string";
/** 任一种标签的身份键。 */
export const anyTabKey = (target: OpenTabRef | CanvasTabRef) =>
  isCanvasTarget(target) ? canvasTabKey(target.path) : openTabKey(target);

const toCanvasTab = (raw: unknown): CanvasOpenTab | null => {
  if (!raw || typeof raw !== "object") return null;
  const path = (raw as Record<string, unknown>).path;
  if (typeof path !== "string") return null;
  const name = canvasNameOf(path);
  if (!name || name.includes("/") || name.includes("\\")) return null;
  return { kind: "canvas", path, name };
};

/** 校验持久化的 Canvas 标签：路径须为 canvas 根下单层文件，按路径去重。 */
export const normalizeCanvasTabs = (value: unknown): CanvasOpenTab[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: CanvasOpenTab[] = [];
  for (const raw of value) {
    const tab = toCanvasTab(raw);
    if (!tab || seen.has(tab.path)) continue;
    seen.add(tab.path);
    result.push(tab);
  }
  return result;
};

/** 最近关闭历史上限：照抄 VCPChat tab-history-controller.js（entries `.slice(0, 100)`）。 */
export const CLOSED_TAB_HISTORY_LIMIT = 100;
/** 单个批次的子项上限：照 VCPChat normalize（batch.tabs 超过 200 视为无效）。 */
export const CLOSED_BATCH_TAB_LIMIT = 200;

export interface ClosedTab extends OpenTabRef {
  title: string;
  ownerName: string;
  avatarColor: string | null;
  closedAt: number;
}

/** 单个关闭的标签。 */
export interface ClosedTabEntry extends ClosedTab {
  kind: "tab";
}

export interface ClosedCanvasTab {
  path: string;
  name: string;
  closedAt: number;
}

/** 单个关闭的 Canvas 标签。 */
export interface ClosedCanvasEntry extends ClosedCanvasTab {
  kind: "canvas";
}

/** 「关闭其他 / 关闭全部」一次关掉的一批（对齐 VCPChat 整窗关闭批次）。 */
export interface ClosedTabBatch {
  kind: "batch";
  id: string;
  closedAt: number;
  tabs: ClosedTab[];
  /** 同批关闭的 Canvas 标签；旧数据没有。 */
  canvasTabs?: ClosedCanvasTab[];
}

export type ClosedHistoryEntry = ClosedTabEntry | ClosedTabBatch | ClosedCanvasEntry;

/** 面板展示用的批次：只含尚未打开的子项，标题按剩余数量计算。 */
export interface ClosedTabBatchView extends ClosedTabBatch {
  title: string;
}

export type RecentlyClosedEntry = ClosedTabEntry | ClosedTabBatchView | ClosedCanvasEntry;

export const closedBatchTitle = (count: number) => `关闭了 ${count} 个标签`;

const positiveTime = (value: unknown, fallback = 0) => {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : fallback;
};

const toClosedTab = (raw: unknown, fallbackClosedAt = 0): ClosedTab | null => {
  const [tab] = normalizeOpenTabs([raw]);
  if (!tab) return null;
  return {
    ownerId: tab.ownerId,
    ownerType: tab.ownerType,
    topicId: tab.topicId,
    title: tab.title,
    ownerName: tab.ownerName,
    avatarColor: tab.avatarColor,
    closedAt: positiveTime((raw as Record<string, unknown>).closedAt, fallbackClosedAt),
  };
};

/**
 * 校验持久化的关闭历史：单条按身份去重（保留靠前的较新条目）；批次按 id 去重，
 * 子项去重，空批次或超过 200 子项的批次丢弃；整体截到上限。旧数据没有 kind，按单条处理。
 */
const toClosedCanvasTab = (raw: unknown, fallbackClosedAt = 0): ClosedCanvasTab | null => {
  const tab = toCanvasTab(raw);
  if (!tab) return null;
  return {
    path: tab.path,
    name: tab.name,
    closedAt: positiveTime((raw as Record<string, unknown>).closedAt, fallbackClosedAt),
  };
};

export const normalizeClosedTabs = (value: unknown): ClosedHistoryEntry[] => {
  if (!Array.isArray(value)) return [];
  const seenTabs = new Set<string>();
  const seenCanvas = new Set<string>();
  const seenBatches = new Set<string>();
  const result: ClosedHistoryEntry[] = [];
  for (const raw of value) {
    if (result.length >= CLOSED_TAB_HISTORY_LIMIT) break;
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (record.kind === "batch") {
      const id = typeof record.id === "string" ? record.id.slice(0, 256) : "";
      if (!id || seenBatches.has(id) || !Array.isArray(record.tabs)) continue;
      const canvasRaw = Array.isArray(record.canvasTabs) ? record.canvasTabs : [];
      if (record.tabs.length + canvasRaw.length > CLOSED_BATCH_TAB_LIMIT) continue;
      const closedAt = positiveTime(record.closedAt);
      const childKeys = new Set<string>();
      const tabs: ClosedTab[] = [];
      for (const child of record.tabs) {
        const tab = toClosedTab(child, closedAt);
        if (!tab || childKeys.has(openTabKey(tab))) continue;
        childKeys.add(openTabKey(tab));
        tabs.push(tab);
      }
      const canvasPaths = new Set<string>();
      const canvasTabs: ClosedCanvasTab[] = [];
      for (const child of canvasRaw) {
        const tab = toClosedCanvasTab(child, closedAt);
        if (!tab || canvasPaths.has(tab.path)) continue;
        canvasPaths.add(tab.path);
        canvasTabs.push(tab);
      }
      if (tabs.length === 0 && canvasTabs.length === 0) continue;
      seenBatches.add(id);
      result.push(
        canvasTabs.length
          ? { kind: "batch", id, closedAt, tabs, canvasTabs }
          : { kind: "batch", id, closedAt, tabs },
      );
      continue;
    }
    if (record.kind === "canvas") {
      const tab = toClosedCanvasTab(record);
      if (!tab || seenCanvas.has(tab.path)) continue;
      seenCanvas.add(tab.path);
      result.push({ kind: "canvas", ...tab });
      continue;
    }
    const tab = toClosedTab(record);
    if (!tab) continue;
    const key = openTabKey(tab);
    if (seenTabs.has(key)) continue;
    seenTabs.add(key);
    result.push({ kind: "tab", ...tab });
  }
  return result;
};

const pickTab = (tab: ClosedTab) => ({
  ownerId: tab.ownerId,
  ownerType: tab.ownerType,
  topicId: tab.topicId,
  title: tab.title,
  ownerName: tab.ownerName,
  avatarColor: tab.avatarColor,
});

const sameTab = (a: OpenTab, b: OpenTab) =>
  a.title === b.title &&
  a.ownerName === b.ownerName &&
  a.avatarColor === b.avatarColor &&
  a.unread === b.unread;

/**
 * 打开的话题标签。数量不设上限；生成并发仍由传输层 8 路上限约束。
 * 语义对齐 VCPChat：当前会话由 chatSessionStore 决定；普通选择一个未打开的话题时，
 * 原位替换当前标签（activeTabKey 槽位），不新增标签；只有 openInNewTab /
 * openNewEmptyTab 这类显式操作才增加标签数。
 */
export const useOpenTabsStore = defineStore("openTabs", () => {
  const sessionStore = useChatSessionStore();
  const topicStore = useTopicStore();
  const assistantStore = useAssistantStore();

  const tabs = ref<OpenTab[]>([]);
  /** 标签栏中的当前槽位；随持久化保存。会话为空时仍保留，供下一次选择原位替换。 */
  const activeTabKey = ref<string | null>(null);
  /** 最近关闭（单条与批次），新的在前；持久化。话题或 owner 被删除时同步移除。 */
  const closedTabs = ref<ClosedHistoryEntry[]>([]);
  const indexOfKey = (key: string | null) =>
    key ? tabs.value.findIndex((tab) => openTabKey(tab) === key) : -1;

  /** Canvas 标签与当前激活的那个（scoped 路径）；激活态不持久化，重启回到聊天。 */
  const canvasTabs = ref<CanvasOpenTab[]>([]);
  const activeCanvasPath = ref<string | null>(null);
  const indexOfCanvas = (path: string) => canvasTabs.value.findIndex((tab) => tab.path === path);

  const sessionKey = computed(() => {
    const key = sessionStore.currentConversationKey;
    return key ? openTabKey(key) : null;
  });
  /** Canvas 标签激活时即为它；否则由当前会话决定（Canvas 内[对话]切换会话不改变激活标签）。 */
  const activeKey = computed(() =>
    activeCanvasPath.value ? canvasTabKey(activeCanvasPath.value) : sessionKey.value,
  );
  /** 上一个激活的标签，供关闭当前 Canvas 标签后回退。 */
  let previousKey: string | null = null;
  watch(activeKey, (next, prev) => {
    if (prev && prev !== next) previousKey = prev;
  });

  const indexOfTab = (target: OpenTabRef) => {
    const key = openTabKey(target);
    return tabs.value.findIndex((tab) => openTabKey(tab) === key);
  };
  const isActive = (target: OpenTabRef) => activeKey.value === openTabKey(target);
  const sameOwner = (
    tab: Pick<OpenTabRef, "ownerId" | "ownerType">,
    ownerId: string,
    ownerType: string,
  ) => tab.ownerId === ownerId && tab.ownerType === ownerType;

  const replaceAt = (index: number, next: OpenTab) => {
    if (!sameTab(tabs.value[index], next)) tabs.value.splice(index, 1, next);
  };

  const removeWhere = (predicate: (tab: OpenTab) => boolean) => {
    if (!tabs.value.some(predicate)) return;
    tabs.value = tabs.value.filter((tab) => !predicate(tab));
  };

  /** 话题或 owner 已不存在：标签与关闭历史（含批次子项）一起清理。 */
  const pruneWhere = (predicate: (tab: OpenTabRef) => boolean) => {
    removeWhere(predicate);
    const hit = closedTabs.value.some((entry) =>
      entry.kind === "batch" ? entry.tabs.some(predicate) : entry.kind === "tab" && predicate(entry),
    );
    if (!hit) return;
    closedTabs.value = closedTabs.value.flatMap((entry): ClosedHistoryEntry[] => {
      if (entry.kind === "canvas") return [entry];
      if (entry.kind === "tab") return predicate(entry) ? [] : [entry];
      const rest = entry.tabs.filter((tab) => !predicate(tab));
      return rest.length || entry.canvasTabs?.length ? [{ ...entry, tabs: rest }] : [];
    });
  };

  const toClosed = (tab: OpenTab, closedAt: number): ClosedTab => ({
    ownerId: tab.ownerId,
    ownerType: tab.ownerType,
    topicId: tab.topicId,
    title: tab.title,
    ownerName: tab.ownerName,
    avatarColor: tab.avatarColor,
    closedAt,
  });

  const toClosedCanvas = (tab: CanvasOpenTab, closedAt: number): ClosedCanvasTab => ({
    path: tab.path,
    name: tab.name,
    closedAt,
  });

  /** 记入最近关闭：单个关闭记单条（同身份旧单条去重）；asBatch 且合计多于 1 个时记为一批。 */
  const recordClosed = (closed: OpenTab[], asBatch = false, closedCanvas: CanvasOpenTab[] = []) => {
    const total = closed.length + closedCanvas.length;
    if (total === 0) return;
    const closedAt = Date.now();
    if (asBatch && total > 1) {
      const limited = closed.slice(0, CLOSED_BATCH_TAB_LIMIT);
      const batch: ClosedTabBatch = {
        kind: "batch",
        id: `batch-${closedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        closedAt,
        tabs: limited.map((tab) => toClosed(tab, closedAt)),
      };
      const canvasRoom = Math.max(0, CLOSED_BATCH_TAB_LIMIT - limited.length);
      const canvasClosed = closedCanvas.slice(0, canvasRoom).map((tab) => toClosedCanvas(tab, closedAt));
      if (canvasClosed.length) batch.canvasTabs = canvasClosed;
      closedTabs.value = [batch, ...closedTabs.value].slice(0, CLOSED_TAB_HISTORY_LIMIT);
      return;
    }
    const entries: ClosedHistoryEntry[] = [
      ...closed.map((tab): ClosedTabEntry => ({ kind: "tab", ...toClosed(tab, closedAt) })),
      ...closedCanvas.map((tab): ClosedCanvasEntry => ({ kind: "canvas", ...toClosedCanvas(tab, closedAt) })),
    ];
    const keys = new Set(closed.map(openTabKey));
    const paths = new Set(closedCanvas.map((tab) => tab.path));
    closedTabs.value = [
      ...entries,
      ...closedTabs.value.filter((entry) =>
        entry.kind === "batch"
          ? true
          : entry.kind === "canvas"
            ? !paths.has(entry.path)
            : !keys.has(openTabKey(entry)),
      ),
    ].slice(0, CLOSED_TAB_HISTORY_LIMIT);
  };

  /**
   * 最近关闭（对齐 VCPChat menuEntries）：已打开的单条与子项不出现；
   * 子项全部已打开的批次不出现，部分打开的只列未打开的子项并重算标题。
   */
  const recentlyClosed = computed<RecentlyClosedEntry[]>(() => {
    const open = new Set(tabs.value.map(openTabKey));
    const openCanvas = new Set(canvasTabs.value.map((tab) => tab.path));
    const result: RecentlyClosedEntry[] = [];
    for (const entry of closedTabs.value) {
      if (entry.kind === "canvas") {
        if (!openCanvas.has(entry.path)) result.push(entry);
        continue;
      }
      if (entry.kind === "tab") {
        if (!open.has(openTabKey(entry))) result.push(entry);
        continue;
      }
      const rest = entry.tabs.filter((tab) => !open.has(openTabKey(tab)));
      const restCanvas = (entry.canvasTabs ?? []).filter((tab) => !openCanvas.has(tab.path));
      const count = rest.length + restCanvas.length;
      if (count) result.push({ ...entry, tabs: rest, canvasTabs: restCanvas, title: closedBatchTitle(count) });
    }
    return result;
  });

  const closedTitle = (key: string): string | null => {
    for (const entry of closedTabs.value) {
      if (entry.kind === "canvas") continue;
      const hit =
        entry.kind === "batch"
          ? entry.tabs.find((tab) => openTabKey(tab) === key)
          : openTabKey(entry) === key
            ? entry
            : undefined;
      if (hit) return hit.title;
    }
    return null;
  };

  const findBatch = (batchId: string) =>
    closedTabs.value.find(
      (entry): entry is ClosedTabBatch => entry.kind === "batch" && entry.id === batchId,
    );

  /** 从批次移除已恢复的子项；子项清空时整批移除（VCPChat saveBatchProgress 置 closedAt=0）。 */
  const removeBatchChildren = (batchId: string, keys: Set<string>) => {
    closedTabs.value = closedTabs.value.flatMap((entry): ClosedHistoryEntry[] => {
      if (entry.kind !== "batch" || entry.id !== batchId) return [entry];
      const rest = entry.tabs.filter((tab) => !keys.has(openTabKey(tab)));
      const restCanvas = (entry.canvasTabs ?? []).filter((tab) => !keys.has(canvasTabKey(tab.path)));
      if (rest.length === 0 && restCanvas.length === 0) return [];
      return [{ ...entry, tabs: rest, canvasTabs: restCanvas.length ? restCanvas : undefined }];
    });
  };

  const findOwner = (ownerType: ConversationOwnerType, ownerId: string) => {
    const owner =
      ownerType === "agent"
        ? assistantStore.agents.find((agent) => agent.id === ownerId)
        : assistantStore.groups.find((group) => group.id === ownerId);
    return owner as { name?: string; avatarCalculatedColor?: string | null } | undefined;
  };

  /** 当前会话写入（或刷新）对应标签，并清掉它的未读点。 */
  const upsertCurrent = () => {
    // Canvas 标签激活时，[对话] 切换的会话不写入标签栏。
    if (activeCanvasPath.value) return;
    const key = sessionStore.currentConversationKey;
    if (!key) return;
    const item = sessionStore.currentSelectedItem;
    const topic = sessionStore.currentTopic;
    const index = indexOfTab(key);
    const previous = index >= 0 ? tabs.value[index] : null;
    const next: OpenTab = {
      ownerId: key.ownerId,
      ownerType: key.ownerType,
      topicId: key.topicId,
      title: topic?.name || previous?.title || key.topicId,
      ownerName: item?.name || previous?.ownerName || "",
      avatarColor: item?.avatarCalculatedColor ?? previous?.avatarColor ?? null,
      unread: false,
    };
    if (index >= 0) {
      replaceAt(index, next);
    } else {
      // 浏览未打开的话题：原位替换当前槽位并保留位置；没有槽位时才追加。
      const slot = indexOfKey(activeTabKey.value);
      if (slot >= 0) tabs.value.splice(slot, 1, next);
      else tabs.value.push(next);
    }
    activeTabKey.value = openTabKey(next);
  };

  /** 显式打开但不激活（例如从别处预先挂一个标签）。 */
  const openTab = (tab: OpenTabRef & Partial<Omit<OpenTab, keyof OpenTabRef>>) => {
    if (indexOfTab(tab) >= 0) return;
    const [normalized] = normalizeOpenTabs([tab]);
    if (normalized) tabs.value.push(normalized);
  };

  /** 切到某个标签对应的会话；成功返回 true。 */
  const activateTab = async (target: OpenTabRef) => {
    const markSlot = () => {
      if (indexOfTab(target) >= 0) activeTabKey.value = openTabKey(target);
    };
    if (isActive(target)) {
      markSlot();
      return true;
    }
    try {
      await sessionStore.selectTopicById(target.ownerId, target.ownerType, target.topicId);
      activeCanvasPath.value = null;
      markSlot();
      return true;
    } catch (error) {
      // selectTopicById 只在 owner 不存在时抛错；列表尚未加载时不据此清理。
      console.warn("[OpenTabs] Failed to activate tab:", error);
      if (assistantStore.agents.length > 0 || assistantStore.groups.length > 0) {
        pruneWhere((tab) => sameOwner(tab, target.ownerId, target.ownerType));
      }
      return false;
    }
  };

  /** 对应 VCPChat 的“在新标签页打开”：插到当前标签右侧并激活；已打开则只切换。 */
  const openInNewTab = async (
    tab: OpenTabRef & Partial<Omit<OpenTab, keyof OpenTabRef>>,
  ) => {
    if (indexOfTab(tab) >= 0) return activateTab(tab);
    const [normalized] = normalizeOpenTabs([tab]);
    if (!normalized) return false;
    const slot = indexOfKey(activeTabKey.value);
    tabs.value.splice(slot >= 0 ? slot + 1 : tabs.value.length, 0, normalized);
    const activated = await activateTab(normalized);
    if (!activated) {
      const key = openTabKey(normalized);
      removeWhere((item) => openTabKey(item) === key);
    }
    return activated;
  };

  /**
   * 对应 VCPChat openItemChatTab：为 owner 新建话题并在新标签打开，返回新话题 id。
   * 移动端没有“复用空话题”的语义，总是新建；命名沿用 TopicCreator。
   */
  const openNewEmptyTab = async (ownerType: ConversationOwnerType, ownerId: string) => {
    const name = `新话题 ${new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })}`;
    let topicId: string | undefined;
    let title = name;
    try {
      const created = await topicStore.createTopic(ownerId, ownerType, name);
      topicId = created?.id;
      title = created?.name || name;
    } catch {
      return null; // createTopic 已发出错误通知。
    }
    if (!topicId) return null;
    const opened = await openInNewTab({ ownerId, ownerType, topicId, title });
    if (!opened) return null;
    if (!topicStore.topics.some((t) => sameOwner(t, ownerId, ownerType) && t.id === topicId)) {
      void topicStore.loadTopicList(ownerId, ownerType).catch(() => {});
    }
    return topicId;
  };

  /** 关闭标签不中止其后台生成。关闭当前标签时切到相邻标签。 */
  const closeTab = async (target: OpenTabRef) => {
    const index = indexOfTab(target);
    if (index < 0) return;
    const wasActive = isActive(target);
    recordClosed(tabs.value.splice(index, 1));
    if (wasActive && tabs.value.length > 0) {
      await activateTab(tabs.value[Math.min(index, tabs.value.length - 1)]);
    }
  };

  const keyIsOpen = (key: string | null) =>
    !!key &&
    (indexOfKey(key) >= 0 || canvasTabs.value.some((tab) => canvasTabKey(tab.path) === key));

  /** 切到 Canvas 标签：不改变当前会话。 */
  const activateCanvasTab = (path: string) => {
    if (indexOfCanvas(path) < 0) return false;
    activeCanvasPath.value = path;
    return true;
  };

  /** 按身份键激活任一种标签。 */
  const activateKey = async (key: string): Promise<boolean> => {
    const chat = tabs.value.find((tab) => openTabKey(tab) === key);
    if (chat) return activateTab(chat);
    const canvasTab = canvasTabs.value.find((tab) => canvasTabKey(tab.path) === key);
    return canvasTab ? activateCanvasTab(canvasTab.path) : false;
  };

  /** 打开文稿：已开则切换，否则追加 Canvas 标签并激活。 */
  const openCanvasTab = (name: string) => {
    const [tab] = normalizeCanvasTabs([{ kind: "canvas", path: canvasPathOf(name) }]);
    if (!tab) return false;
    if (indexOfCanvas(tab.path) < 0) canvasTabs.value.push(tab);
    return activateCanvasTab(tab.path);
  };

  /** 离开 Canvas 但不关闭：依次尝试上一个、当前槽位、第一个聊天标签；都没有时只退出激活态。 */
  const leaveCanvas = async () => {
    if (!activeCanvasPath.value) return true;
    const candidates = [previousKey, activeTabKey.value, tabs.value[0] ? openTabKey(tabs.value[0]) : null];
    for (const key of candidates) {
      const chat = key ? tabs.value.find((tab) => openTabKey(tab) === key) : undefined;
      if (chat && (await activateTab(chat))) return true;
    }
    activeCanvasPath.value = null;
    return false;
  };

  /** 关闭 Canvas 标签；关闭的是当前标签时回到上一个激活标签，其次相邻 Canvas 标签，再次聊天标签。 */
  const closeCanvasTab = async (target: Pick<CanvasOpenTab, "path">) => {
    const index = indexOfCanvas(target.path);
    if (index < 0) return;
    const wasActive = activeCanvasPath.value === target.path;
    const back = previousKey;
    const [closed] = canvasTabs.value.splice(index, 1);
    recordClosed([], false, [closed]);
    if (!wasActive) return;
    if (back && keyIsOpen(back) && (await activateKey(back))) return;
    const neighbor = canvasTabs.value[Math.min(index, canvasTabs.value.length - 1)];
    if (neighbor) {
      activateCanvasTab(neighbor.path);
      return;
    }
    await leaveCanvas();
  };

  /** VCPChat「关闭其他」：保留目标并切过去，其余（两种标签）记入最近关闭。 */
  const closeOtherTabs = async (target: OpenTabRef | CanvasTabRef) => {
    const key = anyTabKey(target);
    if (!keyIsOpen(key)) return;
    const chats = tabs.value.filter((tab) => openTabKey(tab) !== key);
    const canvases = canvasTabs.value.filter((tab) => canvasTabKey(tab.path) !== key);
    if (chats.length + canvases.length === 0) return;
    recordClosed(chats, true, canvases);
    tabs.value = tabs.value.filter((tab) => openTabKey(tab) === key);
    canvasTabs.value = canvasTabs.value.filter((tab) => canvasTabKey(tab.path) === key);
    if (isCanvasTarget(target)) activateCanvasTab(target.path);
    else if (!isActive(target)) await activateTab(target);
  };

  /** VCPChat「关闭全部」：全部记入最近关闭；当前会话不动（与关闭最后一个标签一致）。 */
  const closeAllTabs = () => {
    if (tabs.value.length + canvasTabs.value.length === 0) return;
    recordClosed(tabs.value, true, canvasTabs.value);
    tabs.value = [];
    canvasTabs.value = [];
    activeCanvasPath.value = null;
  };

  /**
   * 批量挂标签：按顺序插到当前标签右侧，不激活、不触发生成，数量不设上限。
   * 已打开的跳过；owner 在本机不存在的跳过（owner 列表未加载时不判定）。
   */
  const openTabsInBackground = (
    items: Array<OpenTabRef & Partial<Omit<OpenTab, keyof OpenTabRef>>>,
  ) => {
    const opened: OpenTab[] = [];
    const alreadyOpen: OpenTabRef[] = [];
    const missing: OpenTabRef[] = [];
    const ownersLoaded = assistantStore.agents.length > 0 || assistantStore.groups.length > 0;
    let slot = indexOfKey(activeTabKey.value);
    for (const item of items) {
      if (indexOfTab(item) >= 0) {
        alreadyOpen.push(item);
        continue;
      }
      const owner = findOwner(item.ownerType, item.ownerId);
      if (!owner && ownersLoaded) {
        missing.push(item);
        continue;
      }
      const [normalized] = normalizeOpenTabs([
        {
          ...item,
          ownerName: item.ownerName || owner?.name || "",
          avatarColor: item.avatarColor ?? owner?.avatarCalculatedColor ?? null,
        },
      ]);
      if (!normalized) {
        missing.push(item);
        continue;
      }
      const at = slot >= 0 ? slot + 1 : tabs.value.length;
      tabs.value.splice(at, 0, normalized);
      if (slot >= 0) slot = at;
      opened.push(normalized);
    }
    return { opened, alreadyOpen, missing };
  };

  /** 最近关闭 · 单条恢复：本机新开（已开则切换），成功后移出历史。 */
  const restoreClosed = async (target: OpenTabRef) => {
    const key = openTabKey(target);
    const entry = closedTabs.value.find(
      (item): item is ClosedTabEntry => item.kind === "tab" && openTabKey(item) === key,
    );
    const opened = await openInNewTab(
      entry ? pickTab(entry) : { ownerId: target.ownerId, ownerType: target.ownerType, topicId: target.topicId },
    );
    if (opened) {
      closedTabs.value = closedTabs.value.filter(
        (item) => item.kind !== "tab" || openTabKey(item) !== key,
      );
    }
    return opened;
  };

  /** 批次 · 恢复单个子项（VCPChat 子项恢复 + saveBatchProgress）。 */
  const restoreClosedBatchChild = async (batchId: string, target: OpenTabRef) => {
    const key = openTabKey(target);
    const child = findBatch(batchId)?.tabs.find((tab) => openTabKey(tab) === key);
    if (!child) return false;
    const opened = await openInNewTab(pickTab(child));
    if (opened) removeBatchChildren(batchId, new Set([key]));
    return opened;
  };

  /** 批次 · 整批恢复：子项按原顺序挂上（不逐个激活），随后激活第一项；恢复的子项移出批次。 */
  const restoreClosedBatch = async (batchId: string) => {
    const batch = findBatch(batchId);
    if (!batch) return { opened: 0, skipped: 0, activated: false };
    const result = openTabsInBackground(batch.tabs.map(pickTab));
    const canvasChildren = batch.canvasTabs ?? [];
    let canvasOpened = 0;
    for (const child of canvasChildren) {
      const [tab] = normalizeCanvasTabs([{ kind: "canvas", path: child.path }]);
      if (!tab || indexOfCanvas(tab.path) >= 0) continue;
      canvasTabs.value.push(tab);
      canvasOpened += 1;
    }
    const restored = new Set([...result.opened, ...result.alreadyOpen].map(openTabKey));
    canvasChildren.forEach((child) => restored.add(canvasTabKey(child.path)));
    removeBatchChildren(batchId, restored);
    const first = batch.tabs.find((tab) => restored.has(openTabKey(tab)));
    let activated = first ? await activateTab(first) : false;
    if (!activated && canvasChildren.length > 0) activated = activateCanvasTab(canvasChildren[0].path);
    return { opened: result.opened.length + canvasOpened, skipped: result.missing.length, activated };
  };

  /** 最近关闭 · 恢复单个 Canvas 标签：重新打开文稿，成功后移出历史。 */
  const restoreClosedCanvas = (path: string) => {
    const opened = openCanvasTab(canvasNameOf(path));
    if (opened) {
      closedTabs.value = closedTabs.value.filter((item) => item.kind !== "canvas" || item.path !== path);
    }
    return opened;
  };

  /** 批次 · 恢复单个 Canvas 子项。 */
  const restoreClosedBatchCanvasChild = (batchId: string, path: string) => {
    const child = findBatch(batchId)?.canvasTabs?.find((tab) => tab.path === path);
    if (!child) return false;
    const opened = openCanvasTab(canvasNameOf(path));
    if (opened) removeBatchChildren(batchId, new Set([canvasTabKey(path)]));
    return opened;
  };

  /** 标签菜单「重命名话题」：走 topicStore.updateTopicTitle（与话题长按「修改标题」同一入口）。 */
  const renameTab = async (target: OpenTabRef, title: string) => {
    const next = title.trim();
    if (!next) return false;
    const result = await topicStore.updateTopicTitle(
      target.ownerId,
      target.ownerType,
      target.topicId,
      next,
    );
    if (result === false) return false;
    // 非当前 owner 时 topicStore 不更新列表，标签标题在这里补上。
    const index = indexOfTab(target);
    if (index >= 0) replaceAt(index, { ...tabs.value[index], title: next });
    return true;
  };

  /** 本地已知的话题名（当前话题列表、标签、关闭历史）；查不到返回 null。 */
  const knownTitle = (target: OpenTabRef): string | null => {
    const key = openTabKey(target);
    const topic = topicStore.topics.find(
      (item) => openTabKey({ ...item, topicId: item.id }) === key,
    );
    if (topic?.name) return topic.name;
    return (
      tabs.value.find((tab) => openTabKey(tab) === key)?.title ??
      closedTitle(key) ??
      null
    );
  };

  const moveTab = (from: number, to: number) => {
    const length = tabs.value.length;
    if (from === to || from < 0 || to < 0 || from >= length || to >= length) return;
    const next = [...tabs.value];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    tabs.value = next;
  };

  /** 持久化恢复后调用：校验数据并补上当前会话。 */
  const sanitizeTabs = () => {
    tabs.value = normalizeOpenTabs(tabs.value);
    closedTabs.value = normalizeClosedTabs(closedTabs.value);
    canvasTabs.value = normalizeCanvasTabs(canvasTabs.value);
    // 旧持久化数据没有 activeTabKey：以当前会话所在标签为准。
    if (indexOfKey(activeKey.value) >= 0) {
      activeTabKey.value = activeKey.value;
    } else if (
      typeof activeTabKey.value !== "string" ||
      indexOfKey(activeTabKey.value) < 0
    ) {
      activeTabKey.value = null;
    }
    upsertCurrent();
  };

  watch(
    () => [
      activeKey.value,
      sessionStore.currentTopic?.name,
      sessionStore.currentSelectedItem?.name,
      sessionStore.currentSelectedItem?.avatarCalculatedColor,
    ],
    upsertCurrent,
    { immediate: true },
  );

  // 当前 owner 的话题列表是该 owner 标签标题与未读的权威来源。
  watch(
    () =>
      topicStore.topics
        .map((t) => `${t.ownerType}\u0000${t.ownerId}\u0000${t.id}\u0000${t.name}\u0000${t.unread}\u0000${t.unreadCount}`)
        .join("\n"),
    () => {
      const byKey = new Map(
        topicStore.topics.map((topic) => [openTabKey({ ...topic, topicId: topic.id }), topic]),
      );
      tabs.value.forEach((tab, index) => {
        const topic = byKey.get(openTabKey(tab));
        if (!topic) return;
        replaceAt(index, {
          ...tab,
          title: topic.name || tab.title,
          unread: !isActive(tab) && (topic.unread || topic.unreadCount !== 0),
        });
      });
    },
  );

  // 话题列表请求的世代：只有没被后续加载或缓存失效覆盖的请求才能用来清理标签。
  let topicListEpoch = 0;
  topicStore.$onAction(({ name, args, after }) => {
    if (name === "invalidateAllTopicCaches") {
      topicListEpoch += 1;
      return;
    }
    if (name === "loadTopicList") {
      const [ownerId, ownerType] = args as [string, ConversationOwnerType];
      const epoch = ++topicListEpoch;
      after(() => {
        // loadTopicList 同步设置 currentAgentId；世代未被覆盖即代表期间没有其他加载或失效。
        if (epoch !== topicListEpoch || topicStore.currentAgentId !== ownerId) {
          return;
        }
        const live = new Set(
          topicStore.topics
            .filter((topic) => sameOwner(topic, ownerId, ownerType))
            .map((topic) => topic.id),
        );
        pruneWhere((tab) => sameOwner(tab, ownerId, ownerType) && !live.has(tab.topicId));
      });
      return;
    }
    if (name === "deleteTopic") {
      const [ownerId, ownerType, topicId] = args as [string, string, string];
      after(() =>
        pruneWhere((tab) => sameOwner(tab, ownerId, ownerType) && tab.topicId === topicId),
      );
      return;
    }
    if (name === "incrementTopicUnreadCount") {
      // chatStreamStore 只对非当前会话的新回复调用；群组同样标点（纯本地展示）。
      const [ownerId, ownerType, topicId] = args as [string, ConversationOwnerType, string];
      const target = { ownerId, ownerType, topicId };
      const index = indexOfTab(target);
      if (index >= 0 && !isActive(target)) {
        replaceAt(index, { ...tabs.value[index], unread: true });
      }
    }
  });

  let snapshotEpoch = 0;
  assistantStore.$onAction(({ name, args, after }) => {
    if (name === "deleteAgent" || name === "deleteGroup") {
      const [ownerId] = args as [string];
      const ownerType: ConversationOwnerType = name === "deleteAgent" ? "agent" : "group";
      after(() => pruneWhere((tab) => sameOwner(tab, ownerId, ownerType)));
      return;
    }
    if (name === "fetchAgentsAndGroups") {
      const epoch = ++snapshotEpoch;
      after(() => {
        // 被后续快照覆盖或列表为空（未加载/加载被作废）时不清理，避免误删全部标签。
        if (epoch !== snapshotEpoch) return;
        if (assistantStore.agents.length === 0 && assistantStore.groups.length === 0) return;
        pruneWhere((tab) => !findOwner(tab.ownerType, tab.ownerId));
        tabs.value.forEach((tab, index) => {
          const owner = findOwner(tab.ownerType, tab.ownerId);
          if (!owner) return;
          replaceAt(index, {
            ...tab,
            ownerName: owner.name || tab.ownerName,
            avatarColor: owner.avatarCalculatedColor ?? tab.avatarColor,
          });
        });
      });
    }
  });

  return {
    tabs,
    closedTabs,
    recentlyClosed,
    openTabsInBackground,
    restoreClosed,
    restoreClosedBatch,
    restoreClosedBatchChild,
    activeKey,
    activeTabKey,
    canvasTabs,
    activeCanvasPath,
    openCanvasTab,
    activateCanvasTab,
    closeCanvasTab,
    leaveCanvas,
    restoreClosedCanvas,
    restoreClosedBatchCanvasChild,
    openTab,
    activateTab,
    openInNewTab,
    openNewEmptyTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    renameTab,
    knownTitle,
    moveTab,
    sanitizeTabs,
  };
}, {
  persist: {
    pick: ["tabs", "activeTabKey", "closedTabs", "canvasTabs"],
    afterHydrate: (context) => {
      (context.store as unknown as { sanitizeTabs: () => void }).sanitizeTabs();
    },
  },
});
