<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { renderSafeMarkdown } from "../../core/utils/safeMarkdown";
import type { CanvasLocalEntry } from "../../core/stores/canvasStore";

const props = defineProps<{
  doc: CanvasLocalEntry;
  read: (name: string) => Promise<string>;
  save: (name: string, content: string) => Promise<boolean>;
}>();

const content = ref("");
const draft = ref("");
const editing = ref(false);
const saving = ref(false);
const loadError = ref<string | null>(null);
const saveHint = ref<string | null>(null);

const dirty = computed(() => editing.value && draft.value !== content.value);
const isMarkdown = computed(() => /\.md$/i.test(props.doc.name));
const html = computed(() => (isMarkdown.value ? renderSafeMarkdown(content.value) : ""));

const load = async () => {
  try {
    content.value = await props.read(props.doc.name);
    loadError.value = null;
    if (!editing.value) draft.value = content.value;
  } catch (error) {
    loadError.value = String(error);
  }
};

// 换文稿或电脑端更新了正文（sha 变化）时重读；编辑中有未保存内容则不打断。
watch(
  () => [props.doc.name, props.doc.sha256] as const,
  ([name], previous) => {
    if (previous && previous[0] !== name) editing.value = false;
    if (!dirty.value) void load();
  },
  { immediate: true },
);

const toggleEdit = () => {
  if (!editing.value) draft.value = content.value;
  editing.value = !editing.value;
  saveHint.value = null;
};

const save = async () => {
  if (saving.value) return;
  saving.value = true;
  try {
    const synced = await props.save(props.doc.name, draft.value);
    content.value = draft.value;
    editing.value = false;
    saveHint.value = synced ? "已保存并同步到电脑端" : "已保存到手机，稍后同步";
  } catch (error) {
    saveHint.value = `保存失败：${String(error)}`;
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <section class="canvas-doc flex flex-col h-full min-h-0">
    <header class="flex items-center gap-2 px-3 py-2 border-b border-black/5 dark:border-white/10">
      <strong class="flex-1 min-w-0 truncate text-[13px] text-[var(--primary-text)]">{{ doc.name }}</strong>
      <span v-if="saveHint" class="text-[11px] opacity-60 text-[var(--primary-text)]">{{ saveHint }}</span>
      <button
        v-if="editing"
        type="button"
        class="px-3 min-h-8 rounded-full text-[12px] font-bold text-white disabled:opacity-50"
        style="background-color: var(--highlight-text)"
        :disabled="saving || !dirty"
        @click="save"
      >
        {{ saving ? "保存中" : "保存" }}
      </button>
      <button
        type="button"
        class="px-3 min-h-8 rounded-full text-[12px] font-bold border border-black/10 dark:border-white/10 text-[var(--primary-text)]"
        :aria-pressed="editing"
        @click="toggleEdit"
      >
        {{ editing ? "预览" : "编辑" }}
      </button>
    </header>
    <p v-if="loadError" class="p-3 text-[12px] text-red-500">读取失败：{{ loadError }}</p>
    <textarea
      v-else-if="editing"
      v-model="draft"
      class="flex-1 min-h-0 w-full p-3 resize-none bg-transparent text-[14px] leading-relaxed text-[var(--primary-text)] outline-none font-mono"
      spellcheck="false"
      aria-label="编辑文稿"
    ></textarea>
    <div v-else class="flex-1 min-h-0 overflow-y-auto p-3 text-[14px] leading-relaxed text-[var(--primary-text)]">
      <div v-if="isMarkdown" class="canvas-markdown" v-html="html"></div>
      <pre v-else class="whitespace-pre-wrap break-words font-sans">{{ content }}</pre>
    </div>
  </section>
</template>
