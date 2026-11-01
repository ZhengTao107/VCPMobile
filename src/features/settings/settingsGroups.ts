/**
 * 设置主页分组（ptp4g#21）：连接 → 同步 → 聊天 → 外观 → 高级。
 * 借鉴桌面端 schema 的 section → card → disclosure 层级：每组一个标题，
 * 组内每行打开一个子页；低频的「高级」整组折叠，默认收起。
 * 只描述布局，子页内容仍由 SettingsView 按 id 渲染现有 Section 组件。
 */

export type SettingsGroupId = "connection" | "sync" | "chat" | "appearance" | "advanced";

export type SettingsPageId =
  | "connection"
  | "configBackup"
  | "sync"
  | "identity"
  | "topicSummary"
  | "theme"
  | "rendering"
  | "maintenance"
  | "guide"
  | "about";

export interface SettingsPageEntry {
  id: SettingsPageId;
  title: string;
  description: string;
}

export interface SettingsGroup {
  id: SettingsGroupId;
  title: string;
  description: string;
  /** 整组折叠在 SettingsDisclosure 内，默认收起 */
  collapsed?: boolean;
  pages: readonly SettingsPageEntry[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "connection",
    title: "连接",
    description: "VCP 服务器、连接档案与配置串",
    pages: [
      { id: "connection", title: "服务器连接", description: "Chat 地址、API Key、WebSocket 与连接档案" },
      { id: "configBackup", title: "配置串与备份", description: "粘贴或复制配置串，导入导出 .vcpcfg 备份" },
    ],
  },
  {
    id: "sync",
    title: "同步",
    description: "与桌面端的数据同步",
    pages: [
      { id: "sync", title: "数据同步", description: "同步地址与 Token、自动同步、同步面板与日志" },
    ],
  },
  {
    id: "chat",
    title: "聊天",
    description: "身份与对话相关设置",
    pages: [
      { id: "identity", title: "用户身份", description: "头像、用户名与管理员账号" },
      { id: "topicSummary", title: "话题总结", description: "话题自动总结使用的模型" },
    ],
  },
  {
    id: "appearance",
    title: "外观",
    description: "主题与消息呈现",
    pages: [
      { id: "theme", title: "主题切换", description: "主题预览与切换" },
      { id: "rendering", title: "消息渲染", description: "排版模式、内容宽度及后续渲染选项" },
    ],
  },
  {
    id: "advanced",
    title: "高级",
    description: "数据维护、帮助与版本信息",
    collapsed: true,
    pages: [
      { id: "maintenance", title: "数据维护", description: "清理 WebView 缓存、刷新预渲染缓存" },
      { id: "guide", title: "帮助与指引", description: "交互教学与功能指引回放" },
      { id: "about", title: "关于与更新", description: "版本、检查更新与项目主页" },
    ],
  },
];

export const findSettingsPage = (id: string | null | undefined): SettingsPageEntry | undefined => {
  if (!id) return undefined;
  for (const group of SETTINGS_GROUPS) {
    const page = group.pages.find((entry) => entry.id === id);
    if (page) return page;
  }
  return undefined;
};
