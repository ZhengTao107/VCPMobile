<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { renderCanvasMarkdown } from "./canvasMarkdown";
import "./canvasDocument.css";
import {
  isArticleName,
  NO_REVISIONS,
  REVISION_STALE_HINT,
  type CanvasLocalEntry,
  type CanvasRevisionSpan,
  type CanvasRevisionView,
} from "../../core/stores/canvasStore";
import { useSettingsStore } from "../../core/stores/settings";
import { hintTargetFromSettings } from "../../core/sync/remoteChangeHint";
import {
  describeTranslationError,
  loadCanvasTranslation,
  runCanvasTranslation,
  translationSettings,
  type CanvasTranslationRecord,
} from "./canvasTranslationRunner";

const props = defineProps<{
  doc: CanvasLocalEntry;
  read: (name: string) => Promise<string>;
  save: (name: string, content: string) => Promise<boolean>;
  /** ptp4g#49 电脑端修订（只读）；不传则不显示。 */
  revisions?: (name: string, content: string) => Promise<CanvasRevisionView>;
}>();

const settingsStore = useSettingsStore();
const canvasTarget = () => hintTargetFromSettings(settingsStore.settings, true);
const content = ref("");
const draft = ref("");
const editing = ref(false);
const saving = ref(false);
const loadError = ref<string | null>(null);
const saveHint = ref<string | null>(null);

const view = ref<"source" | "translation">("source");
const translation = ref<CanvasTranslationRecord | null>(null);
const translating = ref(false);
const progress = ref({ done: 0, total: 0 });
const translateError = ref<string | null>(null);
let translateAbort: AbortController | null = null;

const dirty = computed(() => editing.value && draft.value !== content.value);
const isMarkdown = computed(() => isArticleName(props.doc.name));
const shown = computed(() =>
  view.value === "translation" && translation.value ? translation.value.content : content.value,
);
const html = computed(() => (isMarkdown.value ? renderCanvasMarkdown(shown.value) : ""));
const translationStale = computed(() => !!translation.value && translation.value.sourceSha !== props.doc.sha256);
const translateLabel = computed(() => {
  if (!translating.value) return translation.value ? "重新翻译" : "翻译";
  const { done, total } = progress.value;
  return total ? `翻译中 ${done}/${total}` : "翻译中";
});

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

// ptp4g#49 修订（只读）：只用电脑端 sidecar 缓存的净变更；正文哈希不一致只给轻提示；手机本机保存过即隐藏。
const revisionView = ref<CanvasRevisionView>(NO_REVISIONS);
const showRevisions = ref(false);
const editedHere = ref(false);
let revisionSeq = 0;
watch(
  () => [props.doc.name, content.value] as const,
  async ([name, text], previous) => {
    if (previous && previous[0] !== name) {
      showRevisions.value = false;
      editedHere.value = false;
    }
    const seq = ++revisionSeq;
    revisionView.value = NO_REVISIONS;
    if (!props.revisions || !text) return;
    try {
      const next = await props.revisions(name, text);
      if (seq === revisionSeq) revisionView.value = next;
    } catch {
      if (seq === revisionSeq) revisionView.value = NO_REVISIONS;
    }
  },
  { immediate: true },
);
const revisionsReady = computed(() => {
  const current = revisionView.value;
  return !editedHere.value && current.status === "ready" ? current : null;
});
const revisionsStale = computed(() => !editedHere.value && revisionView.value.status === "stale");
const revisionTotal = computed(() => {
  const counts = revisionsReady.value?.counts;
  return counts ? counts.insert + counts.delete + counts.replace : 0;
});
const revisionTitle = (span: CanvasRevisionSpan) =>
  [span.author, span.timestamp ? new Date(span.timestamp).toLocaleString() : ""].filter(Boolean).join(" · ");
const toggleRevisions = () => {
  showRevisions.value = !showRevisions.value;
  if (showRevisions.value) view.value = "source";
};

const cancelTranslate = () => {
  translateAbort?.abort();
  translateAbort = null;
  translating.value = false;
};

watch(
  () => props.doc.name,
  async (name) => {
    cancelTranslate();
    translation.value = null;
    translateError.value = null;
    view.value = "source";
    try {
      const { model, targetLanguage } = translationSettings(settingsStore.settings);
      const record = await loadCanvasTranslation(name, undefined, {
        sourceSha: props.doc.sha256,
        model,
        targetLanguage,
        target: canvasTarget(),
      });
      if (props.doc.name === name) translation.value = record;
    } catch {
      translation.value = null;
    }
  },
  { immediate: true },
);

const translate = async () => {
  if (translating.value) {
    cancelTranslate();
    return;
  }
  const name = props.doc.name;
  const controller = new AbortController();
  translateAbort = controller;
  translating.value = true;
  translateError.value = null;
  progress.value = { done: 0, total: 0 };
  try {
    const { model, targetLanguage } = translationSettings(settingsStore.settings);
    const record = await runCanvasTranslation({
      name,
      content: content.value,
      sourceSha: props.doc.sha256,
      target: canvasTarget(),
      model,
      targetLanguage,
      previous: translation.value,
      signal: controller.signal,
      onProgress: (next) => {
        if (translateAbort === controller) progress.value = next;
      },
    });
    if (translateAbort !== controller) return;
    translation.value = record;
    view.value = "translation";
    if (record.untranslatedCount > 0) {
      translateError.value = `${record.untranslatedCount} 段未译出，已保留原文；再点“重新翻译”只补译这些段`;
    }
  } catch (error) {
    if (translateAbort === controller) translateError.value = describeTranslationError(error);
  } finally {
    if (translateAbort === controller) {
      translateAbort = null;
      translating.value = false;
    }
  }
};

onBeforeUnmount(cancelTranslate);

const toggleEdit = () => {
  if (!editing.value) {
    draft.value = content.value;
    view.value = "source";
  }
  editing.value = !editing.value;
  saveHint.value = null;
};

const save = async () => {
  if (saving.value) return;
  saving.value = true;
  try {
    const synced = await props.save(props.doc.name, draft.value);
    content.value = draft.value;
    editedHere.value = true;
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
      <div v-if="!editing && translation" class="inline-flex p-0.5 rounded-full bg-[var(--secondary-bg)]" role="group">
        <button
          v-for="item in [{ id: 'source', label: '原文' }, { id: 'translation', label: '译文' }] as const"
          :key="item.id"
          type="button"
          class="px-2.5 min-h-7 rounded-full text-[11px] font-bold"
          :class="view === item.id ? 'text-white' : 'text-[var(--primary-text)] opacity-70'"
          :style="view === item.id ? 'background-color: var(--highlight-text)' : ''"
          :aria-pressed="view === item.id"
          @click="view = item.id"
        >
          {{ item.label }}
        </button>
      </div>
      <button
        v-if="!editing && revisionsReady"
        type="button"
        class="px-3 min-h-8 rounded-full text-[12px] font-bold border border-black/10 dark:border-white/10 text-[var(--primary-text)]"
        :aria-pressed="showRevisions"
        @click="toggleRevisions"
      >
        修订 {{ revisionTotal }}
      </button>
      <button
        v-if="!editing"
        type="button"
        class="px-3 min-h-8 rounded-full text-[12px] font-bold border border-black/10 dark:border-white/10 text-[var(--primary-text)]"
        :aria-label="translating ? '取消翻译' : '翻译'"
        @click="translate"
      >
        {{ translateLabel }}
      </button>
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
    <p v-if="translateError" class="px-3 py-1.5 text-[12px] text-red-500" role="alert">{{ translateError }}</p>
    <p
      v-else-if="view === 'translation' && translationStale"
      class="px-3 py-1.5 text-[11px] opacity-70 text-[var(--primary-text)]"
    >
      译文基于旧版本，原文已更新；点“重新翻译”只译改动的段
    </p>
    <p
      v-if="revisionsStale && !editing"
      class="px-3 py-1.5 text-[11px] opacity-70 text-[var(--primary-text)]"
      role="status"
      data-rev="stale"
    >
      {{ REVISION_STALE_HINT }}
    </p>
    <p v-if="loadError" class="p-3 text-[12px] text-red-500">读取失败：{{ loadError }}</p>
    <textarea
      v-else-if="editing"
      v-model="draft"
      class="flex-1 min-h-0 w-full p-3 resize-none bg-transparent text-[14px] leading-relaxed text-[var(--primary-text)] outline-none font-mono"
      spellcheck="false"
      aria-label="编辑文稿"
    ></textarea>
    <div v-else class="flex-1 min-h-0 overflow-y-auto text-[var(--primary-text)]">
      <template v-if="showRevisions && revisionsReady && view === 'source'">
        <p class="px-3 pt-2 text-[11px] opacity-60" data-rev="summary">
          新增 {{ revisionsReady.counts.insert }} · 删除 {{ revisionsReady.counts.delete }} · 替换
          {{ revisionsReady.counts.replace }}<template v-if="revisionsReady.authors.length">
            · {{ revisionsReady.authors.join("、") }}</template>
        </p>
        <pre
          class="p-3 text-[14px] leading-relaxed whitespace-pre-wrap break-words font-sans"
        ><template v-for="(span, index) in revisionsReady.spans" :key="index"><ins
          v-if="span.kind === 'ins'"
          data-rev="ins"
          class="no-underline rounded-sm bg-green-500/15 text-green-700 dark:text-green-300"
          :title="revisionTitle(span)"
        >{{ span.text }}</ins><del
          v-else-if="span.kind === 'del'"
          data-rev="del"
          class="line-through rounded-sm bg-red-500/10 text-red-600 dark:text-red-300"
          :title="revisionTitle(span)"
        >{{ span.text }}</del><template v-else>{{ span.text }}</template></template></pre>
      </template>
      <div v-else-if="isMarkdown" class="markdown-preview canvas-markdown" v-html="html"></div>
      <pre v-else class="p-3 text-[14px] leading-relaxed whitespace-pre-wrap break-words font-sans">{{ shown }}</pre>
    </div>
  </section>
</template>
