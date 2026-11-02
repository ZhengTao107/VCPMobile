// 与电脑 VCPChat 侧栏一致（modules/itemListManager.js createGroupCollage）：
// 群组没有自定义头像时，用 members 顺序中前 4 位仍存在的 Agent 拼成群头像；
// 没头像的成员用名字前两个字符（大写）占位。
export const GROUP_COLLAGE_MAX = 4;

export interface GroupCollageMember {
  id: string;
  name: string;
}

export const pickGroupCollageMembers = (
  memberIds: readonly string[] | null | undefined,
  agents: readonly { id: string; name: string }[],
): GroupCollageMember[] => {
  if (!Array.isArray(memberIds) || memberIds.length === 0) return [];
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const picked: GroupCollageMember[] = [];
  for (const id of memberIds) {
    const agent = byId.get(id);
    if (!agent) continue;
    picked.push({ id: agent.id, name: agent.name });
    if (picked.length === GROUP_COLLAGE_MAX) break;
  }
  return picked;
};

export const collageInitials = (name: string | null | undefined): string =>
  String(name || "?").trim().slice(0, 2).toUpperCase();
