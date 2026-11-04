<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { renderSafeMarkdown } from "../../core/utils/safeMarkdown";
import {
  listLocalChildren,
  readChildHistory,
  requestSidechatSync,
  sidechatLocal,
  type SidechatChild,
  type SidechatMessage,
} from "../../core/sync/sidechatRemote";
import { useChatStreamStore } from "../../core/stores/chatStreamStore";
import { sendSidechatMessage, sidechatSending, stopSidechatMessage } from "./sidechatSend";

const route = useRoute();
const router = useRouter();
const stream = useChatStreamStore();
const parentTopicId = computed(() => String(route.query.parentTopicId ?? ""));
const parentTitle = computed(() => String(route.query.title ?? "子话题"));

const loading = ref(true);
const error = ref("");
const children = ref<SidechatChild[]>([]);
const selected = ref<SidechatChild | null>(null);
const messages = ref<SidechatMessage[]>([]);
const pendingUser = ref<SidechatMessage | null>(null);
const draft = ref("");

const sending = computed(() => !!selected.value && sidechatSending.has(selected.value.dir));
const live = computed(() => {
  const child = selected.value;
  const id = child ? sidechatSending.get(child.dir) : "";
  if (!child || !id) return null;
  return stream.getActiveStreamMessage(child.agentId, "agent", child.topicId, id) ?? null;
});
const shown = computed(() => {
  const user = pendingUser.value;
  return user && !messages.value.some((m) => m.id === user.id) ? [...messages.value, user] : messages.value;
});

const formatTime = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString() : "");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    await requestSidechatSync();
    children.value = await listLocalChildren(parentTopicId.value, sidechatLocal);
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function reloadHistory(child: SidechatChild) {
  const list = await readChildHistory(child, sidechatLocal);
  if (selected.value?.dir === child.dir) messages.value = list;
}

async function openChild(child: SidechatChild) {
  selected.value = child;
  messages.value = [];
  pendingUser.value = null;
  error.value = "";
  try {
    await reloadHistory(child);
  } catch (e) {
    error.value = String(e);
  }
}

async function send() {
  const child = selected.value;
  if (!child || sending.value || !draft.value.trim()) return;
  error.value = "";
  try {
    const result = await sendSidechatMessage(child, draft.value, {
      onUser: (message) => {
        pendingUser.value = message;
        draft.value = "";
      },
    });
    if (result !== "sent") return;
  } catch (e) {
    error.value = String(e);
  }
  if (selected.value?.dir !== child.dir) return;
  try {
    await reloadHistory(child);
  } catch (e) {
    error.value = String(e);
  }
  pendingUser.value = null;
}

async function stop() {
  if (!selected.value) return;
  try {
    await stopSidechatMessage(selected.value);
  } catch (e) {
    error.value = String(e);
  }
}

// 离开后再进入时由别处发起的生成结束：重读权威历史。
watch(sending, (now, before) => {
  if (before && !now && selected.value && !pendingUser.value) {
    void reloadHistory(selected.value).catch(() => {});
  }
});

function goBack() {
  if (selected.value) {
    selected.value = null;
    messages.value = [];
    pendingUser.value = null;
    return;
  }
  void router.push("/chat");
}

onMounted(load);
</script>

<template>
  <div class="sidechat-view flex flex-col h-full" style="padding-top: env(safe-area-inset-top)">
    <header class="flex items-center gap-2 px-3 py-2 border-b border-black/10">
      <button type="button" class="px-2 py-1" data-testid="sidechat-back" @click="goBack">返回</button>
      <span class="font-semibold truncate">
        {{ selected ? selected.topicId : `${parentTitle} · 子话题` }}
      </span>
      <span v-if="sending" class="ml-auto text-xs opacity-60">生成中…</span>
    </header>

    <div v-if="error" class="px-3 py-2 text-sm text-red-500" data-testid="sidechat-error">{{ error }}</div>

    <div class="flex-1 overflow-y-auto">
      <template v-if="!selected">
        <div v-if="loading" class="p-4 text-sm opacity-70">正在同步…</div>
        <div v-else-if="children.length === 0" class="p-4 text-sm opacity-70" data-testid="sidechat-empty">
          这个话题还没有子话题，或尚未从电脑同步过来。
        </div>
        <button
          v-for="child in children"
          :key="child.dir"
          type="button"
          class="block w-full text-left px-4 py-3 border-b border-black/5"
          data-testid="sidechat-child"
          @click="openChild(child)"
        >
          <div class="text-sm font-medium truncate">{{ child.topicId }}</div>
          <div class="text-xs opacity-60">{{ formatTime(child.createdAt) }}</div>
        </button>
      </template>

      <template v-else>
        <div
          v-for="msg in shown"
          :key="msg.id"
          class="px-4 py-3 border-b border-black/5"
          data-testid="sidechat-message"
        >
          <div class="text-xs opacity-60 mb-1">
            {{ msg.name || msg.role }} · {{ formatTime(msg.timestamp) }}
          </div>
          <div class="prose prose-sm max-w-none" v-html="renderSafeMarkdown(msg.content)"></div>
        </div>
        <div v-if="live" :key="live.id" class="px-4 py-3 border-b border-black/5" data-testid="sidechat-live">
          <div class="text-xs opacity-60 mb-1">{{ live.name || "assistant" }}</div>
          <div v-if="live.isThinking && !live.content" class="text-sm opacity-60">思考中…</div>
          <div v-else class="prose prose-sm max-w-none" v-html="renderSafeMarkdown(live.content || '')"></div>
        </div>
      </template>
    </div>

    <footer
      v-if="selected"
      class="flex items-end gap-2 px-3 py-2 border-t border-black/10"
      style="padding-bottom: calc(0.5rem + env(safe-area-inset-bottom))"
    >
      <textarea
        v-model="draft"
        rows="1"
        class="flex-1 resize-none rounded border border-black/10 px-2 py-1 text-sm"
        placeholder="继续这个子话题…"
        data-testid="sidechat-input"
      ></textarea>
      <button v-if="sending" type="button" class="px-3 py-1" data-testid="sidechat-stop" @click="stop">停止</button>
      <button
        v-else
        type="button"
        class="px-3 py-1"
        :disabled="!draft.trim()"
        data-testid="sidechat-send"
        @click="send"
      >
        发送
      </button>
    </footer>
  </div>
</template>
