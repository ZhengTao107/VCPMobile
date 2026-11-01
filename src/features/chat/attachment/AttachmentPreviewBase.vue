<template>
  <div class="attachment-preview-base relative flex items-center bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl transition-all"
       :class="[sizeClass, { 'hover:bg-black/10 dark:hover:bg-white/10': !isLoading && !isProcessing && !isFailed, 'ring-2 ring-red-500/80': isFailed }]"
       :title="isFailed ? `${file.name}：${failReasonText}` : undefined">
    <!-- Default slot for content -->
    <slot />
    
    <!-- Delete Button (Only shown when showRemove is true) -->
    <button
      v-if="showRemove"
      @click.stop="emit('remove', index)"
      class="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-800/90 rounded-full flex items-center justify-center text-white shadow-lg active:scale-90 transition-transform border border-white/20 z-20"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>

    <!-- Loading Overlay -->
    <div
      v-if="isLoading || isProcessing"
      class="absolute inset-0 bg-black/40 rounded-xl flex flex-col items-center justify-center z-10 gap-1"
    >
      <div
        v-if="isLoading"
        class="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"
      ></div>
      <span
        v-if="isLoading && file.progress !== undefined"
        class="text-[9px] text-white font-bold tabular-nums"
      >{{ file.progress }}%</span>
      <span
        v-if="isProcessing"
        class="text-[9px] text-white/80 font-mono select-none"
      >解析中...</span>
    </div>

    <!-- Failed Overlay：点击展开原因与移除 -->
    <div
      v-if="isFailed"
      data-testid="attachment-failed"
      role="button"
      tabindex="0"
      :aria-expanded="reasonOpen"
      :aria-label="`${file.name} 导入失败，点击查看原因`"
      class="absolute inset-0 bg-red-950/60 rounded-xl flex flex-col items-center justify-center z-10 gap-0.5 p-1 text-white"
      @click.stop="reasonOpen = !reasonOpen"
      @keydown.enter.prevent="reasonOpen = !reasonOpen"
    >
      <span v-if="!reasonOpen" class="text-[9px] font-bold select-none">失败</span>
      <template v-else>
        <span
          data-testid="attachment-fail-reason"
          class="flex-1 min-h-0 w-full overflow-y-auto text-[8px] leading-tight break-all text-center"
        >{{ failReasonText }}</span>
        <button
          type="button"
          data-testid="attachment-fail-remove"
          class="shrink-0 text-[9px] font-bold px-1.5 rounded bg-white/90 text-red-700 active:scale-95"
          @click.stop="emit('remove', index)"
        >移除</button>
      </template>
    </div>

    <!-- 红色角标 -->
    <span
      v-if="isFailed"
      data-testid="attachment-failed-badge"
      aria-hidden="true"
      class="absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow-lg border border-white/40 z-20"
    >!</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { Attachment } from "../../../core/types/chat";

interface Props {
  file: Attachment;
  index: number;
  size?: 'small' | 'medium' | 'large' | 'auto';
  showRemove?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  size: 'medium',
  showRemove: false
});

const emit = defineEmits<{ (e: "remove", index: number): void }>();

const isLoading = computed(() => props.file.status === "loading");
const isProcessing = computed(() => props.file.status === "processing");
const isFailed = computed(() => props.file.status === "failed");
const failReasonText = computed(() => props.file.failReason || "处理失败");
const reasonOpen = ref(false);

const sizeClass = computed(() => {
  switch (props.size) {
    case 'small':
      return 'w-10 h-10';
    case 'large':
      return 'w-20 h-20';
    case 'auto':
      return 'min-w-[40px] h-auto';
    case 'medium':
      default:
        return 'w-14 h-14';
  }
});
</script>

<style scoped>
.list-enter-active,
.list-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.list-enter-from {
  opacity: 0;
  transform: translateX(20px) scale(0.8);
}

.list-leave-to {
  opacity: 0;
  transform: translateY(-20px) scale(0.8);
}
</style>
