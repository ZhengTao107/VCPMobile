import { ref, computed } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useAudioRecorder } from './useAudioRecorder';
import { isAndroid } from '../utils/platform';

export type SpeechStopResult = { ok: true; text: string } | { ok: false; error: string };

export interface BackendTranscribeOptions {
  serverUrl: string;
  apiKey: string;
  /** 提交时请求后端同步等待的秒数（后端会再按 AudioSyncWaitSeconds 截断） */
  waitSec?: number;
  /** 整次转写（提交 + 轮询）的总超时 */
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

const TRANSCRIBE_HASH_RE = /^[a-f0-9]{64}$/i;

const blobToAudioDataUrl = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  // 后端只收 data:audio/*；recorder 的 mimeType 可能带 ;codecs=opus，后端正则允许
  const mime = blob.type && blob.type.startsWith('audio/') ? blob.type : 'audio/webm';
  return `data:${mime};base64,${btoa(binary)}`;
};

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

const describeTranscribeHttpError = (status: number, body: any, phase: 'submit' | 'poll'): string => {
  const detail = typeof body?.error === 'string' && body.error ? `：${body.error}` : '';
  if (status === 503) return '后端未开启语音转写（ImageProcessor AudioTranscribe=false），请在服务器开启后重试';
  if (status === 401 || status === 403) return 'API 密钥无效或无权访问语音转写，请检查设置中的 VCP API Key';
  if (status === 404) {
    return phase === 'submit'
      ? '后端不支持 /v1/audio-transcribe，请升级 VCPToolBox'
      : '转写任务已丢失，请重新录音';
  }
  if (status === 400) return `语音转写请求参数错误${detail}`;
  if (status === 422) return `语音转写失败${detail}`;
  return `服务器返回 ${status}${detail}`;
};

/**
 * 录音降级路径：提交到 VCPToolBox 的 POST /v1/audio-transcribe，
 * 202 时按 hash 轮询 GET /v1/audio-transcribe/:hash；提交与轮询共用一个总超时。
 */
export async function transcribeViaBackend(blob: Blob, opts: BackendTranscribeOptions): Promise<SpeechStopResult> {
  const {
    serverUrl,
    apiKey,
    waitSec = 20,
    timeoutMs = 30_000,
    pollIntervalMs = 1_000,
    fetchImpl = globalThis.fetch.bind(globalThis),
  } = opts;

  let origin: string;
  try {
    // 只取 origin，兼容配置了完整 /v1/chat/completions 的地址
    origin = new URL(serverUrl).origin;
  } catch {
    return { ok: false, error: 'VCP 服务器地址格式无效' };
  }
  const endpoint = `${origin}/v1/audio-transcribe`;
  const authHeaders = { Authorization: `Bearer ${apiKey}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const data = await blobToAudioDataUrl(blob);
    let phase: 'submit' | 'poll' = 'submit';
    let res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, waitSec }),
      signal: controller.signal,
    });

    for (;;) {
      const body: any = await res.json().catch(() => null);
      if (res.status === 200 && body?.status === 'done') {
        return { ok: true, text: String(body.text ?? '').trim() };
      }
      if (res.status !== 202) {
        return { ok: false, error: describeTranscribeHttpError(res.status, body, phase) };
      }
      const hash = String(body?.hash ?? '');
      if (!TRANSCRIBE_HASH_RE.test(hash)) {
        return { ok: false, error: '服务器返回的转写任务标识无效' };
      }
      await abortableSleep(pollIntervalMs, controller.signal);
      phase = 'poll';
      res = await fetchImpl(`${endpoint}/${hash}`, { headers: authHeaders, signal: controller.signal });
    }
  } catch (err: any) {
    if (controller.signal.aborted) {
      return { ok: false, error: `语音转写超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试` };
    }
    return { ok: false, error: `网络错误，无法连接 VCP 服务器：${err?.message || String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

export function useSpeechRecognition() {
  const settingsStore = useSettingsStore();
  const { isRecording, startRecording, stopRecording, cancelRecording } = useAudioRecorder();

  const isListening = ref(false);
  const transcriptionResult = ref('');
  const interimTranscription = ref('');
  const isFallbackMode = ref(false); // 是否已降级为云端 Whisper 录音识别模式

  // 判定当前设备环境是否原生支持 Web Speech Recognition API
  const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const isNativeSupported = computed(() => !!SpeechRecognitionClass);

  let recognitionInstance: any = null;
  let finalTranscriptAccumulator = '';

  const initNativeRecognition = (onResultCallback: (text: string) => void) => {
    if (!SpeechRecognitionClass) return;

    const rec = new SpeechRecognitionClass();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'zh-CN'; // 默认采用中文识别

    rec.onstart = () => {
      isListening.value = true;
      transcriptionResult.value = '';
      interimTranscription.value = '';
      finalTranscriptAccumulator = '';
    };

    rec.onresult = (event: any) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      if (finalTranscript) {
        finalTranscriptAccumulator += finalTranscript;
      }

      interimTranscription.value = interimTranscript;
      const totalResult = finalTranscriptAccumulator + interimTranscript;
      transcriptionResult.value = totalResult;

      onResultCallback(totalResult);
    };

    rec.onerror = (event: any) => {
      console.warn('[SpeechRecognition] Native error encountered:', event.error);
      
      // 捕获系统级别无法提供语音识别服务 (例如定制系统无 Google 语音服务框架)
      if (event.error === 'service-not-allowed' || event.error === 'network') {
        console.log('[SpeechRecognition] Service unavailable. Triggering cloud fallback path.');
        isFallbackMode.value = true;
        // 结束原生实例并转移到录音状态
        stopListening();
        startListening(onResultCallback);
      }
    };

    rec.onend = () => {
      isListening.value = false;
    };

    recognitionInstance = rec;
  };

  /**
   * 开启语音输入
   */
  const startListening = async (onResultCallback: (text: string) => void): Promise<void> => {
    transcriptionResult.value = '';
    interimTranscription.value = '';

    // 1. 如果支持原生且未激活降级，首选本地 Google 流式转文字
    if (isNativeSupported.value && !isFallbackMode.value) {
      try {
        if (isAndroid) {
          try {
            // 主动在原生端触发 Android 麦克风录音权限弹窗申请
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('plugin:vcp-mobile|request_android_permission', { pType: 'microphone' });
          } catch (pe) {
            console.warn('[SpeechRecognition] Failed to request native microphone permission:', pe);
          }
        }

        if (!recognitionInstance) {
          initNativeRecognition(onResultCallback);
        }
        recognitionInstance.start();
      } catch (err) {
        console.error('[SpeechRecognition] Failed to start native recognition:', err);
        isFallbackMode.value = true;
        await startListening(onResultCallback); // 降级递归
      }
    } else {
      // 2. 降级为录音 + 云端 Whisper API 转写
      console.log('[SpeechRecognition] Native recognition unsupported. Initiating Whisper mode.');
      isFallbackMode.value = true;
      try {
        await startRecording();
        isListening.value = true;
      } catch (err) {
        console.error('[SpeechRecognition] Failed to start recorder in fallback:', err);
        throw err;
      }
    }
  };

  /**
   * 停止语音输入并获取识别结果（降级模式下会提交后端转写）
   */
  const stopListening = async (): Promise<SpeechStopResult> => {
    if (!isListening.value) return { ok: true, text: transcriptionResult.value };

    if (!isFallbackMode.value && recognitionInstance) {
      // 原生模式：直接结束，内容已在 onresult 中累加完成
      recognitionInstance.stop();
      isListening.value = false;
      return { ok: true, text: transcriptionResult.value };
    }

    // 降级模式：停止录音 -> 提交 VCPToolBox /v1/audio-transcribe -> 返回结构化结果
    isListening.value = false;
    const recordResult = await stopRecording();
    if (!recordResult) return { ok: false, error: '未获取到录音数据，请重试' };

    const serverUrl = settingsStore.settings?.vcpServerUrl;
    const apiKey = settingsStore.settings?.vcpApiKey;
    if (!serverUrl || !apiKey) {
      console.warn('[SpeechRecognition] Server settings missing for backend transcription.');
      return { ok: false, error: '未配置 VCP 服务器地址或 API 密钥，无法完成识别' };
    }

    const result = await transcribeViaBackend(recordResult.blob, { serverUrl, apiKey });
    if (result.ok) {
      transcriptionResult.value = result.text;
    } else {
      console.error('[SpeechRecognition] Backend transcription failed:', result.error);
    }
    return result;
  };

  /**
   * 取消当前倾听
   */
  const cancelListening = (): void => {
    if (!isListening.value) return;

    if (!isFallbackMode.value && recognitionInstance) {
      recognitionInstance.abort();
    } else {
      cancelRecording();
    }
    isListening.value = false;
    transcriptionResult.value = '';
    interimTranscription.value = '';
  };

  return {
    isListening,
    isFallbackMode,
    transcriptionResult,
    interimTranscription,
    startListening,
    stopListening,
    cancelListening,
    isRecording,
  };
}
