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

const sameTab = (a: OpenTab, b: OpenTab) =>
  a.title === b.title &&
  a.ownerName === b.ownerName &&
  a.avatarColor === b.avatarColor &&
  a.unread === b.unread;

/**
 * 打开的话题标签。数量不设上限；生成并发仍由传输层 8 路上限约束。
 * 当前会话由 chatSessionStore 决定，本 store 只维护列表：选中任何话题即自动打开。
 */
export const useOpenTabsStore = defineStore("openTabs", () => {
  const sessionStore = useChatSessionStore();
  const topicStore = useTopicStore();
  const assistantStore = useAssistantStore();

  const tabs = ref<OpenTab[]>([]);

  const activeKey = computed(() => {
    const key = sessionStore.currentConversationKey;
    return key ? openTabKey(key) : null;
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

  const findOwner = (ownerType: ConversationOwnerType, ownerId: string) => {
    const owner =
      ownerType === "agent"
        ? assistantStore.agents.find((agent) => agent.id === ownerId)
        : assistantStore.groups.find((group) => group.id === ownerId);
    return owner as { name?: string; avatarCalculatedColor?: string | null } | undefined;
  };

  /** 当前会话写入（或刷新）对应标签，并清掉它的未读点。 */
  const upsertCurrent = () => {
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
    if (index >= 0) replaceAt(index, next);
    else tabs.value.push(next);
  };

  /** 显式打开但不激活（例如从别处预先挂一个标签）。 */
  const openTab = (tab: OpenTabRef & Partial<Omit<OpenTab, keyof OpenTabRef>>) => {
    if (indexOfTab(tab) >= 0) return;
    const [normalized] = normalizeOpenTabs([tab]);
    if (normalized) tabs.value.push(normalized);
  };

  const activateTab = async (target: OpenTabRef) => {
    if (isActive(target)) return;
    try {
      await sessionStore.selectTopicById(target.ownerId, target.ownerType, target.topicId);
    } catch (error) {
      // selectTopicById 只在 owner 不存在时抛错；列表尚未加载时不据此清理。
      console.warn("[OpenTabs] Failed to activate tab:", error);
      if (assistantStore.agents.length > 0 || assistantStore.groups.length > 0) {
        removeWhere((tab) => sameOwner(tab, target.ownerId, target.ownerType));
      }
    }
  };

  /** 关闭标签不中止其后台生成。关闭当前标签时切到相邻标签。 */
  const closeTab = async (target: OpenTabRef) => {
    const index = indexOfTab(target);
    if (index < 0) return;
    const wasActive = isActive(target);
    tabs.value.splice(index, 1);
    if (wasActive && tabs.value.length > 0) {
      await activateTab(tabs.value[Math.min(index, tabs.value.length - 1)]);
    }
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
        removeWhere((tab) => sameOwner(tab, ownerId, ownerType) && !live.has(tab.topicId));
      });
      return;
    }
    if (name === "deleteTopic") {
      const [ownerId, ownerType, topicId] = args as [string, string, string];
      after(() =>
        removeWhere((tab) => sameOwner(tab, ownerId, ownerType) && tab.topicId === topicId),
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
      after(() => removeWhere((tab) => sameOwner(tab, ownerId, ownerType)));
      return;
    }
    if (name === "fetchAgentsAndGroups") {
      const epoch = ++snapshotEpoch;
      after(() => {
        // 被后续快照覆盖或列表为空（未加载/加载被作废）时不清理，避免误删全部标签。
        if (epoch !== snapshotEpoch) return;
        if (assistantStore.agents.length === 0 && assistantStore.groups.length === 0) return;
        removeWhere((tab) => !findOwner(tab.ownerType, tab.ownerId));
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
    activeKey,
    openTab,
    activateTab,
    closeTab,
    moveTab,
    sanitizeTabs,
  };
}, {
  persist: {
    pick: ["tabs"],
    afterHydrate: (context) => {
      (context.store as unknown as { sanitizeTabs: () => void }).sanitizeTabs();
    },
  },
});
