import { Copy, Edit3, X, XCircle } from "lucide-vue-next";
import type { OverlayActionItem, PromptConfig } from "../../../core/types/overlay";
import {
  isCanvasTarget,
  type CanvasOpenTab,
  type CanvasTabRef,
  type OpenTab,
  type OpenTabRef,
} from "../../../core/stores/openTabsStore";

export interface TabMenuDeps {
  tabCount: number;
  closeTab: (target: OpenTabRef | CanvasTabRef) => unknown;
  closeOtherTabs: (target: OpenTabRef | CanvasTabRef) => unknown;
  closeAllTabs: () => unknown;
  renameTab: (target: OpenTabRef, title: string) => Promise<boolean>;
  openPrompt: (config: PromptConfig) => void;
  copyText: (text: string) => Promise<void>;
  notify: (type: "info" | "error", title: string, message: string) => void;
}

const copyAction = (label: string, text: string, done: string, deps: TabMenuDeps): OverlayActionItem => ({
  label,
  icon: Copy,
  handler: async () => {
    try {
      await deps.copyText(text);
      deps.notify("info", "复制成功", done);
    } catch (error) {
      console.error("Failed to copy ID:", error);
      deps.notify("error", "复制失败", "无法访问剪贴板");
    }
  },
});

/**
 * 标签长按菜单，对齐 VCPChat 标签右键（side-pane-controller.js：close-tab / close-others /
 * close-all / rename / copy-id）。重命名与复制沿用话题长按菜单的同一入口与文案。
 * Canvas 标签没有话题可重命名：隐藏重命名，复制项改为复制文稿路径。
 */
export function buildTabMenuActions(tab: OpenTab | CanvasOpenTab, deps: TabMenuDeps): OverlayActionItem[] {
  const common: OverlayActionItem[] = [
    {
      label: "关闭标签",
      icon: X,
      handler: () => void deps.closeTab(tab),
    },
    {
      label: "关闭其他标签",
      icon: XCircle,
      disabled: deps.tabCount < 2,
      handler: () => void deps.closeOtherTabs(tab),
    },
    {
      label: "关闭全部标签",
      icon: XCircle,
      handler: () => void deps.closeAllTabs(),
    },
  ];
  if (isCanvasTarget(tab)) {
    return [...common, copyAction("复制路径", tab.path, "文稿路径已复制到剪贴板", deps)];
  }
  return [
    ...common,
    {
      label: "重命名话题",
      icon: Edit3,
      handler: () =>
        deps.openPrompt({
          title: "修改话题标题",
          initialValue: tab.title,
          placeholder: "请输入新的话题标题...",
          onConfirm: (value: string) => {
            if (!value || !value.trim()) return;
            deps.renameTab(tab, value).catch((error) => {
              console.error("[OpenTabs] Failed to rename topic:", error);
              deps.notify("error", "重命名失败", "无法修改话题标题");
            });
          },
        }),
    },
    copyAction("复制话题 ID", tab.topicId, "话题 ID 已复制到剪贴板", deps),
  ];
}
