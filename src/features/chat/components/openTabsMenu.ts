import { Copy, Edit3, X, XCircle } from "lucide-vue-next";
import type { OverlayActionItem, PromptConfig } from "../../../core/types/overlay";
import type { OpenTab, OpenTabRef } from "../../../core/stores/openTabsStore";

export interface TabMenuDeps {
  tabCount: number;
  closeTab: (target: OpenTabRef) => unknown;
  closeOtherTabs: (target: OpenTabRef) => unknown;
  closeAllTabs: () => unknown;
  renameTab: (target: OpenTabRef, title: string) => Promise<boolean>;
  openPrompt: (config: PromptConfig) => void;
  copyText: (text: string) => Promise<void>;
  notify: (type: "info" | "error", title: string, message: string) => void;
}

/**
 * 标签长按菜单，对齐 VCPChat 标签右键（side-pane-controller.js：close-tab / close-others /
 * close-all / rename / copy-id）。重命名与复制沿用话题长按菜单的同一入口与文案。
 */
export function buildTabMenuActions(tab: OpenTab, deps: TabMenuDeps): OverlayActionItem[] {
  return [
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
    {
      label: "复制话题 ID",
      icon: Copy,
      handler: async () => {
        try {
          await deps.copyText(tab.topicId);
          deps.notify("info", "复制成功", "话题 ID 已复制到剪贴板");
        } catch (error) {
          console.error("Failed to copy ID:", error);
          deps.notify("error", "复制失败", "无法访问剪贴板");
        }
      },
    },
  ];
}
