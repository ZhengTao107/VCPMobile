<script setup lang="ts">
import { computed } from "vue";
import VcpAvatar from "../../components/ui/VcpAvatar.vue";
import { useAvatarStore } from "../../core/stores/avatar";
import { useAssistantStore } from "../../core/stores/assistant";
import { collageInitials, pickGroupCollageMembers } from "./groupCollage";

const props = defineProps<{
  groupId: string;
  groupName: string;
  members: readonly string[] | null | undefined;
  size?: string;
  dominantColor?: string | null;
}>();

const avatarStore = useAvatarStore();
const assistantStore = useAssistantStore();

// batch_get_avatars 元数据含 group 行；保存头像后 refreshAvatar 也会写入。
const hasCustomAvatar = computed(() => avatarStore.metadata.has(`group:${props.groupId}`));
const collage = computed(() =>
  hasCustomAvatar.value ? [] : pickGroupCollageMembers(props.members, assistantStore.agents),
);
</script>

<template>
  <VcpAvatar
    v-if="collage.length === 0"
    owner-type="group"
    :owner-id="groupId"
    :fallback-name="groupName"
    :size="size || 'w-10 h-10'"
    rounded="rounded-full"
    :dominant-color="dominantColor"
  />
  <div
    v-else
    class="group-avatar-collage relative flex-shrink-0"
    :class="size || 'w-10 h-10'"
    :data-count="collage.length"
  >
    <div v-for="member in collage" :key="member.id" class="group-avatar-cell">
      <VcpAvatar
        owner-type="agent"
        :owner-id="member.id"
        :fallback-name="member.name"
        :fallback-text="collageInitials(member.name)"
        fallback-text-class="text-[8px]"
        size="w-full h-full"
        rounded="rounded-full"
      />
    </div>
  </div>
</template>

<style scoped>
/* 布局照搬 VCPChat styles/components.css:1687-1736 */
.group-avatar-collage {
  --group-cell-size: 56%;
}
.group-avatar-collage[data-count="1"] {
  --group-cell-size: 100%;
}
.group-avatar-cell {
  position: absolute;
  width: var(--group-cell-size);
  height: var(--group-cell-size);
  border-radius: 50%;
  box-shadow: 0 0 0 1.5px var(--secondary-bg);
}
.group-avatar-collage[data-count="1"] .group-avatar-cell { inset: 0; }
.group-avatar-collage[data-count="2"] .group-avatar-cell:nth-child(1),
.group-avatar-collage[data-count="4"] .group-avatar-cell:nth-child(1) { top: 0; left: 0; }
.group-avatar-collage[data-count="3"] .group-avatar-cell:nth-child(1) { top: 0; left: 22%; }
.group-avatar-collage[data-count="2"] .group-avatar-cell:nth-child(2) { right: 0; bottom: 0; }
.group-avatar-collage[data-count="3"] .group-avatar-cell:nth-child(2) { bottom: 0; left: 0; }
.group-avatar-collage[data-count="4"] .group-avatar-cell:nth-child(2) { top: 0; right: 0; }
.group-avatar-collage[data-count="3"] .group-avatar-cell:nth-child(3) { bottom: 0; right: 0; }
.group-avatar-collage[data-count="4"] .group-avatar-cell:nth-child(3) { bottom: 0; left: 0; }
.group-avatar-collage[data-count="4"] .group-avatar-cell:nth-child(4) { bottom: 0; right: 0; }
</style>
