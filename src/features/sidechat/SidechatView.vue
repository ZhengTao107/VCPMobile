<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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

const route = useRoute();
const router = useRouter();
const parentTopicId = computed(() => String(route.query.parentTopicId ?? ""));
const parentTitle = computed(() => String(route.query.title ?? "子话题"));

const loading = ref(true);
const error = ref("");
const children = ref<SidechatChild[]>([]);
const selected = ref<SidechatChild | null>(null);
const messages = ref<SidechatMessage[]>([]);

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

async function openChild(child: SidechatChild) {
  selected.value = child;
  messages.value = [];
  error.value = "";
  try {
    messages.value = await readChildHistory(child, sidechatLocal);
  } catch (e) {
    error.value = String(e);
  }
}

function goBack() {
  if (selected.value) {
    selected.value = null;
    messages.value = [];
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
      <span class="ml-auto text-xs opacity-60">只读</span>
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
          v-for="msg in messages"
          :key="msg.id"
          class="px-4 py-3 border-b border-black/5"
          data-testid="sidechat-message"
        >
          <div class="text-xs opacity-60 mb-1">
            {{ msg.name || msg.role }} · {{ formatTime(msg.timestamp) }}
          </div>
          <div class="prose prose-sm max-w-none" v-html="renderSafeMarkdown(msg.content)"></div>
        </div>
      </template>
    </div>
  </div>
</template>
