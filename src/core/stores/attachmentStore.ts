import { defineStore } from "pinia";
import { ref, nextTick } from "vue";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useNotificationStore } from "./notification";
import { isAndroid } from "../utils/platform";
import type { PickedFile, PickedFileBatch, PickFileMode } from "tauri-plugin-vcp-mobile";
import type {
  NativeFileProgressDetail,
  NativeFileStartDetail,
} from "../types/native";
import type {
  Attachment,
  AttachmentData,
  AttachmentRegisterProgressDto,
  ChatMessage,
} from "../types/chat";



/**
 * 前端辅助：异步读取图片原始分辨率（不依赖后端）
 * 用于上传前拦截超限图片（>8K×8K）
 */
const checkImageDimensions = (file: File): Promise<{ width: number; height: number }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片尺寸"));
    };
    img.src = url;
  });
};

/** 原生多选默认上限；Kotlin/Rust 另有 16 的硬上限 */
export const NATIVE_PICK_MAX_ITEMS = 9;
/**
 * 原生 picker 空闲熔断：每收到一个原生事件即续期。
 * Kotlin 转码阶段最长 300s 且期间不发进度事件，因此留出余量。
 */
export const NATIVE_PICK_IDLE_TIMEOUT_MS = 6 * 60 * 1000;

export interface NativePickArgs {
  mode: PickFileMode;
  multiple?: boolean;
  maxItems?: number;
}

/** gallery/file 走多选；avatar/camera 保持单选，参数与旧版完全一致 */
export const nativePickArgs = (mode: PickFileMode): NativePickArgs =>
  mode === "gallery" || mode === "file"
    ? { mode, multiple: true, maxItems: NATIVE_PICK_MAX_ITEMS }
    : { mode };

type TicketedDetail = { stagingTicket?: string };

/** 原生失败项：回执 failed[] 与 vcp-mobile-file-failed 事件同形 */
interface NativePickFailureDetail {
  stagingTicket?: string;
  name?: string;
  reason?: string;
}

interface NativePickResult {
  files: PickedFile[];
  failed: NativePickFailureDetail[];
  skipped: number;
}

/** 单选回执是 PickedFile；多选回执（及 batch 事件）是 {files, failed, skipped} */
const normalizePickReply = (res: PickedFile | PickedFileBatch | null | undefined): NativePickResult => {
  if (!res) return { files: [], failed: [], skipped: 0 };
  if ("files" in res) return { files: res.files ?? [], failed: res.failed ?? [], skipped: res.skipped ?? 0 };
  return { files: [res], failed: [], skipped: 0 };
};

const newStableId = () => `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

export const useAttachmentStore = defineStore("attachment", () => {
  // 暂存的附件列表，准备随下一条消息发送
  const stagedAttachments = ref<Attachment[]>([]);

  // 全局监听 Rust 端发出的注册进度，用于大文件哈希/移动等Phase 2流程
  listen<AttachmentRegisterProgressDto>("vcp-file-register-progress", (event) => {
    const { progress, stableId } = event.payload;
    if (stableId) {
      const idx = stagedAttachments.value.findIndex((a) => a.id === stableId);
      if (idx !== -1 && stagedAttachments.value[idx].status === "loading") {
        if (progress >= 99) {
          // 进度达到 99% 说明物理传输/Hash已完毕，开始进入后端同步文本提取的 processing 阶段
          stagedAttachments.value[idx].status = "processing";
          stagedAttachments.value[idx].progress = undefined;
        } else {
          const currentProgress = stagedAttachments.value[idx].progress || 0;
          // 防抖/防回退：仅在进度增加时更新
          if (progress > currentProgress) {
            stagedAttachments.value[idx].progress = progress;
          }
        }
      }
    }
  });

  /**
   * 处理消息中的本地资源路径 (仅附件)，使用 Tauri 原生 asset:// 协议绕过 WebView 限制
   */
  const resolveMessageAssets = (msg: ChatMessage) => {
    // 处理附件 (仅处理图片类型)
    if (msg.attachments && msg.attachments.length > 0) {
      msg.attachments.forEach((att: Attachment) => {
        // Rust 后端返回的路径现在主要在 internalPath，如果不在，回退到 src
        const sourcePath = att.internalPath || att.src;
        if (
          att.type.startsWith("image/") &&
          sourcePath &&
          !sourcePath.startsWith("http") &&
          !sourcePath.startsWith("data:")
        ) {
          try {
            att.resolvedSrc = convertFileSrc(sourcePath);
          } catch (err) {
            console.warn(
              `[AttachmentStore] Failed to convert attachment image path ${att.name}:`,
              err,
            );
          }
        }
      });
    }
  };

  /**
   * HTML `<input>` 子路径的单文件暂存：格式/尺寸拦截 → 卡片 → store_file 或高速链路。
   * 被拦截时通知并静默返回；上传失败时清理卡片并抛出。
   */
  const stageBrowserFile = async (file: File): Promise<void> => {
    console.log(
      `[AttachmentStore] Selected file via HTML input: ${file.name}, type: ${file.type}, size: ${file.size}`,
    );

    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const notificationStore = useNotificationStore();

    // ⚡ 附件防线：拦截无法解析的二进制/未知异构格式 (调用后端统一检测接口)
    try {
      await invoke("check_attachment_support", { originalName: file.name });
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      notificationStore.addNotification({
        type: "warning",
        title: "不支持的附件格式",
        message: errMsg.startsWith("❌") ? errMsg : `❌ ${errMsg}`,
        toastOnly: false,
      });
      return;
    }

    const isGif = ext === 'gif' || file.type === 'image/gif';
    const isImage = file.type.startsWith('image/');

    // 1. 大小拦截：非 GIF 图片 > 10MB 直接拒绝
    if (isImage && !isGif && file.size > 10 * 1024 * 1024) {
      notificationStore.addNotification({
        type: "warning",
        title: "图片过大",
        message: "图片过大（>10MB），请压缩后重试。",
        toastOnly: true,
      });
      return;
    }

    // 2. 分辨率拦截：非 GIF 图片 > 8Kx8K 直接拒绝
    if (isImage && !isGif) {
      try {
        const dims = await checkImageDimensions(file);
        if (dims.width > 8192 || dims.height > 8192) {
          notificationStore.addNotification({
            type: "warning",
            title: "分辨率过高",
            message: "图片分辨率过高（>8K），请压缩后重试。",
            toastOnly: true,
          });
          return;
        }
      } catch (e) {
        console.warn("[AttachmentStore] Failed to check image dimensions:", e);
        // 尺寸检测失败不阻断上传，继续
      }
    }

    // 3. 生成稳定 ID 并使用 unshift 插入首位 (实现"最新附件最先看到")
    const stableId = newStableId();
    const blobUrl = URL.createObjectURL(file);

    stagedAttachments.value.unshift({
      id: stableId,
      type: file.type || "application/octet-stream",
      src: blobUrl,
      name: file.name,
      size: file.size,
      status: "loading",
    });

    await nextTick();
    window.dispatchEvent(new Event("resize"));

    try {
      let finalData: AttachmentData | null = null;

      // --- 分流策略：小文件 ( < 2MB ) 走 IPC，大文件走高速 TCP 链路 ---
      if (file.size < 2 * 1024 * 1024) {
        console.log(
          `[AttachmentStore] Small file detected (<2MB), using store_file IPC for ${file.name}`,
        );
        // 将 File 转换为 Uint8Array (Tauri v2 支持直接传递二进制)
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        // 零拷贝 IPC 发送前直接切入 processing 阶段，后端同步做文本提取
        const attIndex = stagedAttachments.value.findIndex(
          (a) => a.id === stableId,
        );
        if (attIndex !== -1) {
          stagedAttachments.value[attIndex].status = "processing";
        }

        finalData = await invoke<AttachmentData>("store_file", {
          originalName: file.name,
          fileBytes: bytes,
          mimeType: file.type || "application/octet-stream",
        });
      } else {
        console.log(
          `[AttachmentStore] Large file detected, opening High-Speed Link for ${file.name} (${file.size} bytes)`,
        );

        // 1. 准备链路 (Rust 开启临时本地 TCP 接收器)
        const endpoint = await invoke<{ url: string; token: string }>("prepare_vcp_upload", {
          metadata: {
            name: file.name,
            mime: file.type || "application/octet-stream",
            size: file.size,
          },
        });

        // 2. 内核级搬运 (利用流式上传)
        const xhr = new XMLHttpRequest();
        const uploadPromise = new Promise<AttachmentData>((res, rej) => {
          xhr.open("POST", endpoint.url, true);
          xhr.setRequestHeader(
            "Content-Type",
            "application/octet-stream",
          );
          xhr.setRequestHeader("X-Upload-Token", endpoint.token);

          let lastUpdate = 0;
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const now = Date.now();
              // 限制刷新频率为 ~30fps (每 33ms 刷新一次)，避免高频重绘导致卡顿
              if (now - lastUpdate < 33) return;
              lastUpdate = now;

              const progress = Math.round(
                (event.loaded / event.total) * 100,
              );
              const attIndex = stagedAttachments.value.findIndex(
                (a) => a.id === stableId,
              );
              if (attIndex !== -1) {
                if (progress >= 99) {
                  stagedAttachments.value[attIndex].status = "processing";
                  stagedAttachments.value[attIndex].progress = undefined;
                } else {
                  stagedAttachments.value[attIndex].progress = progress;
                }
              }
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              res(JSON.parse(xhr.responseText) as AttachmentData);
            } else {
              rej(new Error(`Upload failed with status ${xhr.status}`));
            }
          };

          xhr.onerror = () => rej(new Error("XHR Network Error"));
          xhr.send(file);
        });

        finalData = await uploadPromise;
      }

      if (finalData) {
        const index = stagedAttachments.value.findIndex(
          (a) => a.id === stableId,
        );
        if (index !== -1) {
          stagedAttachments.value[index] = {
            ...stagedAttachments.value[index],
            type: finalData.type,
            src: finalData.internalPath,
            name: finalData.name,
            size: finalData.size,
            hash: finalData.hash,
            status: "done",
          };
        }
      }
    } catch (err) {
      console.error("[AttachmentStore] High-speed upload failed:", err);
      const index = stagedAttachments.value.findIndex(
        (a) => a.id === stableId,
      );
      if (index !== -1) stagedAttachments.value.splice(index, 1);
      throw err;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  };

  /**
   * 触发文件选择器并暂存附件；Android 使用原生选择器，其他环境沿用 HTML 导入。
   * gallery/file 支持多选，每个文件一张卡片、逐个串行注册，单个失败不影响其余。
   */
  const handleAttachment = async (mode: 'camera' | 'gallery' | 'file' = 'file') => {
    if (mode === 'camera' && !isAndroid) return;

    // ==================================================================
    // Android 端主链路：原生插件拦截直传
    //   - 不走下方的 store_file / prepare_vcp_upload 分流逻辑
    //   - 由 Kotlin 侧的 VcpMobilePlugin.pickFile 启动系统选择器
    //     （gallery 多选在 API≥33 用系统照片选择器）
    //   - Native 层逐个流式拷贝到 cacheDir 并计算 SHA-256，事件带 stagingTicket，
    //     最后逐个通过 register_local_file 零拷贝注册到附件目录
    // ==================================================================
    if (isAndroid) {
      console.log(`[AttachmentStore] Using native picker. Mode: ${mode}`);
      const notificationStore = useNotificationStore();
      const pickArgs = nativePickArgs(mode);
      const multi = pickArgs.multiple === true;

      // stagingTicket → 卡片 stableId；单选模式下所有事件归同一张卡片
      const singleKey = "__single__";
      const cardIds = new Map<string, string>();
      // stableId → 原生失败；回执与事件按 ticket 合并，同一文件只提示一次
      const failures = new Map<string, { name?: string; reason: string }>();
      const cardIdFor = (ticket?: string) => {
        const key = multi && ticket ? ticket : singleKey;
        let id = cardIds.get(key);
        if (!id) {
          id = newStableId();
          cardIds.set(key, id);
        }
        return id;
      };
      const recordFailure = (f: NativePickFailureDetail) => {
        const id = cardIdFor(f.stagingTicket);
        const prev = failures.get(id);
        failures.set(id, {
          name: prev?.name ?? f.name,
          reason: prev?.reason ?? (f.reason || "处理失败"),
        });
      };
      const findCard = (id: string) => stagedAttachments.value.findIndex((a) => a.id === id);
      const dropCard = (id: string) => {
        const idx = findCard(id);
        if (idx !== -1) stagedAttachments.value.splice(idx, 1);
      };
      const ensureCard = (id: string, name: string | undefined, mime: string | undefined, size: number | undefined, progress: number) => {
        if (findCard(id) !== -1) return;
        stagedAttachments.value.unshift({
          id,
          type: mime || "application/octet-stream",
          src: "",
          name: name || "文件",
          size: size || 0,
          progress,
          status: "loading",
        });
      };

      try {
        // 1. 原生 picker：invoke 回执与 CustomEvent 双轨，任一先到即结算；空闲熔断随事件续期。
        //    回执自带失败项与截断数，先于事件到达也不丢失败原因；事件只负责进度和回执丢失时的兜底。
        const pickResult = await new Promise<NativePickResult>((resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;

          const settle = (finish: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            finish();
          };
          const arm = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              settle(() => reject(new Error("Native file picker timed out without reporting")));
            }, NATIVE_PICK_IDLE_TIMEOUT_MS);
          };

          const handleStart = (event: Event) => {
            if (settled) return;
            arm();
            const { name, size, mime, stagingTicket } = (event as CustomEvent<NativeFileStartDetail & TicketedDetail>).detail;
            ensureCard(cardIdFor(stagingTicket), name, mime, size, 0);
          };

          const handleProgress = (event: Event) => {
            if (settled) return;
            arm();
            const { progress, name, mime, total, stagingTicket } = (event as CustomEvent<NativeFileProgressDetail & TicketedDetail>).detail;
            const id = cardIdFor(stagingTicket);
            const scaledProgress = Math.round(progress * 0.9); // Kotlin 沙盒拷贝与哈希阶段占 90%
            const idx = findCard(id);
            if (idx !== -1) {
              stagedAttachments.value[idx].progress = scaledProgress;
            } else if (name) {
              // 自我修复：如果 WebView 错过了 vcp-mobile-file-start 事件，在这里补建卡片
              ensureCard(id, name, mime, total, scaledProgress);
            }
          };

          const handlePicked = (event: Event) => {
            if (settled) return;
            if (!multi) {
              const picked = (event as CustomEvent<PickedFile>).detail;
              console.log("[AttachmentStore] Native picker returned via EventBus:", picked);
              settle(() => resolve(normalizePickReply(picked)));
              return;
            }
            arm(); // 多选：单个文件完成只续期，等批次结果
          };

          const handleFailed = (event: Event) => {
            if (settled) return;
            arm();
            recordFailure((event as CustomEvent<NativePickFailureDetail>).detail);
          };

          const handleBatch = (event: Event) => {
            if (settled || !multi) return;
            const batch = (event as CustomEvent<PickedFileBatch>).detail;
            console.log("[AttachmentStore] Native multi-picker returned via EventBus:", batch);
            settle(() => resolve(normalizePickReply(batch)));
          };

          const listeners: Array<[string, (event: Event) => void]> = [
            ['vcp-mobile-file-start', handleStart],
            ['vcp-mobile-file-progress', handleProgress],
            ['vcp-mobile-file-picked', handlePicked],
            ['vcp-mobile-file-failed', handleFailed],
            ['vcp-mobile-file-batch', handleBatch],
          ];
          const cleanup = () => {
            for (const [name, handler] of listeners) window.removeEventListener(name, handler);
            if (timer) clearTimeout(timer);
          };
          for (const [name, handler] of listeners) window.addEventListener(name, handler);
          arm();

          invoke<PickedFile | PickedFileBatch | null>("plugin:vcp-mobile|pick_file", { ...pickArgs })
            .then((res) => {
              console.log("[AttachmentStore] Native picker returned via Invoke:", res);
              settle(() => resolve(normalizePickReply(res)));
            })
            .catch((err) => settle(() => reject(err)));
        });

        // 2. 逐个串行：格式检测 → 缩略图 → register_local_file（照 App.vue 分享入口写法）
        const unsupported: string[] = [];
        const failed: string[] = [];
        const handledIds = new Set<string>();
        // 以回执为准：失败项并入事件已记录的失败（同 ticket 去重）
        for (const failure of pickResult.failed) recordFailure(failure);

        for (const picked of pickResult.files) {
          if (!picked?.path) continue;
          const id = cardIdFor(picked.stagingTicket);
          handledIds.add(id);

          // ⚡ 附件防线：拦截无法解析的二进制/未知异构格式 (调用后端统一检测接口)
          if (picked.name) {
            try {
              await invoke("check_attachment_support", { originalName: picked.name });
            } catch (err: any) {
              const errMsg = err?.message || String(err);
              unsupported.push(errMsg.startsWith("❌") ? errMsg : `❌ ${errMsg}`);
              dropCard(id);
              continue;
            }
          }

          try {
            // 兜底：如果卡片还没插入，补插一张
            ensureCard(id, picked.name, picked.mime, picked.size, 90);
            const cardIdx = findCard(id);
            if (cardIdx !== -1) {
              stagedAttachments.value[cardIdx].progress = 90;
              // 缩略图展示策略：若有 native thumbnail 物理路径则通过 convertFileSrc 转换，否则如果为图片，转换 path 自身
              const displaySrc = picked.thumbnailPath
                ? convertFileSrc(picked.thumbnailPath)
                : picked.mime?.startsWith("image/")
                  ? convertFileSrc(picked.path)
                  : "";
              if (displaySrc) stagedAttachments.value[cardIdx].src = displaySrc;
            }

            await nextTick();
            window.dispatchEvent(new Event("resize"));

            // 3. 后端零拷贝直传与注册 (会触发 rename 移动，缩略图生成，文本提取)
            const finalData = await invoke<AttachmentData>("register_local_file", {
              localPath: picked.path,
              originalName: picked.name,
              mimeType: picked.mime || "application/octet-stream",
              thumbnailPath: picked.thumbnailPath || null,
              stableId: id,
              expectedHash: picked.hash || null,
            });

            if (finalData) {
              const index = findCard(id);
              if (index !== -1) {
                stagedAttachments.value[index] = {
                  ...stagedAttachments.value[index],
                  type: finalData.type,
                  src: finalData.internalPath,
                  name: finalData.name,
                  size: finalData.size,
                  hash: finalData.hash,
                  thumbnailPath: finalData.thumbnailPath ?? undefined,
                  status: "done",
                  progress: undefined,
                };
              }
            }
          } catch (err: any) {
            console.error(`[AttachmentStore] Registering ${picked.name} failed:`, err);
            dropCard(id);
            failed.push(`${picked.name || "文件"}: ${err?.message || String(err)}`);
          }
        }

        // 4. 原生已建卡但没有返回结果的（处理失败、取消或空路径）清理掉
        for (const id of new Set(cardIds.values())) {
          if (handledIds.has(id)) continue;
          const idx = findCard(id);
          const failure = failures.get(id);
          const name = failure?.name ?? (idx !== -1 ? stagedAttachments.value[idx].name : undefined) ?? "文件";
          dropCard(id);
          if (failure) {
            failed.push(`${name}: ${failure.reason}`);
          } else {
            console.log("[AttachmentStore] Pick cancelled or returned empty path.");
          }
        }

        if (unsupported.length > 0) {
          notificationStore.addNotification({
            type: "warning",
            title: "不支持的附件格式",
            message: unsupported.join("\n"),
            toastOnly: false,
          });
        }
        if (failed.length > 0) {
          notificationStore.addNotification({
            type: "warning",
            title: `${failed.length} 个文件导入失败`,
            message: `❌ ${failed.join("\n")}`,
            toastOnly: true,
          });
        }
        if (pickResult.skipped > 0) {
          notificationStore.addNotification({
            type: "warning",
            title: "已达选择上限",
            message: `单次最多 ${pickArgs.maxItems ?? NATIVE_PICK_MAX_ITEMS} 个，已忽略 ${pickResult.skipped} 个`,
            toastOnly: true,
          });
        }
      } catch (err: any) {
        console.error("[AttachmentStore] Native file pick & registration failed:", err);
        // 清理由于取消或失败而滞留的暂存卡片
        for (const id of new Set(cardIds.values())) dropCard(id);

        const errMsg = err?.message || String(err);
        const isCancelled = errMsg === "Cancelled" || errMsg.includes("Cancelled") || errMsg.includes("cancel");
        if (!isCancelled) {
          notificationStore.addNotification({
            type: "warning",
            title: "选取附件失败",
            message: `❌ 异常捕获: ${errMsg}`,
            toastOnly: true,
          });
        }
      }
      return;
    }

    // ==================================================================
    // 尚无原生 adapter 时的独立 HTML `<input>` 子路径；不代表 native picker 已实现
    //   - gallery/file 允许多选，逐个串行处理；单个失败不影响其余，最后抛出首个错误
    //   - 含旧版分流逻辑：小文件 (<2MB) 走 store_file IPC；大文件走
    //     prepare_vcp_upload 高速 TCP 链路
    //   - Android 端已在上方通过原生插件处理，不会执行到此处
    // ==================================================================
    return new Promise<void>((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = mode !== 'camera';

      // 根据模式设置 accept 和 capture
      if (mode === 'camera') {
        input.accept = "image/*";
        input.setAttribute("capture", "environment");
      } else if (mode === 'gallery') {
        input.accept = "image/*";
      } else {
        input.accept = "*/*";
      }

      input.onchange = async (e: Event) => {
        const target = e.target as HTMLInputElement;
        const files = target.files ? Array.from(target.files) : [];
        let firstError: unknown = null;
        for (const file of files) {
          try {
            await stageBrowserFile(file);
          } catch (err) {
            console.error(
              "[AttachmentStore] Failed to pick or store attachment:",
              err,
            );
            if (firstError === null) firstError = err;
          }
        }
        if (firstError !== null) {
          reject(firstError);
        } else {
          resolve();
        }
      };

      input.oncancel = () => {
        resolve();
      };

      input.click();
    });
  };

  /**
   * 移除特定位置的暂存附件
   */
  const removeStaged = (index: number) => {
    if (index >= 0 && index < stagedAttachments.value.length) {
      stagedAttachments.value.splice(index, 1);
    }
  };

  /**
   * 清空暂存附件
   */
  const clearStaged = () => {
    stagedAttachments.value = [];
  };

  return {
    stagedAttachments,
    handleAttachment,
    resolveMessageAssets,
    removeStaged,
    clearStaged,
  };
});
