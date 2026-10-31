import { describe, expect, it, vi } from 'vitest';
import { transcribeViaBackend } from '@/core/composables/useSpeechRecognition';

const HASH = 'a'.repeat(64);
const SERVER = 'http://vcp.local:6005/v1/chat/completions';
const ENDPOINT = 'http://vcp.local:6005/v1/audio-transcribe';

const audio = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm;codecs=opus' });

const reply = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

const hangUntilAbort = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });

describe('transcribeViaBackend', () => {
  it('submits a data URL and returns text on direct 200 done', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      reply(200, { status: 'done', hash: HASH, text: '  你好世界 ', durationSec: 1.2, cached: false }),
    );

    const result = await transcribeViaBackend(audio(), { serverUrl: SERVER, apiKey: 'key', fetchImpl });

    expect(result).toEqual({ ok: true, text: '你好世界' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer key');
    const body = JSON.parse(init.body);
    expect(body.data).toBe('data:audio/webm;codecs=opus;base64,AQIDBA==');
    expect(body.waitSec).toBe(20);
  });

  it('polls GET /:hash after 202 until done', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(202, { status: 'pending', hash: HASH, etaSec: 3 }))
      .mockResolvedValueOnce(reply(202, { status: 'pending', hash: HASH, etaSec: 1 }))
      .mockResolvedValueOnce(reply(200, { status: 'done', hash: HASH, text: '轮询结果' }));

    const result = await transcribeViaBackend(audio(), {
      serverUrl: SERVER, apiKey: 'key', fetchImpl, pollIntervalMs: 1,
    });

    expect(result).toEqual({ ok: true, text: '轮询结果' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${ENDPOINT}/${HASH}`);
    expect(fetchImpl.mock.calls[1][1].method).toBeUndefined();
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer key');
  });

  it('reports a clear message when backend transcription is disabled (503)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      reply(503, { status: 'disabled', error: '音频转写已关闭（ImageProcessor AudioTranscribe=false）' }),
    );

    const result = await transcribeViaBackend(audio(), { serverUrl: SERVER, apiKey: 'key', fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('后端未开启语音转写');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out the submit request', async () => {
    const fetchImpl = vi.fn(hangUntilAbort);

    const result = await transcribeViaBackend(audio(), {
      serverUrl: SERVER, apiKey: 'key', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('超时');
  });

  it('applies the total timeout across polling', async () => {
    const fetchImpl = vi.fn(async () => reply(202, { status: 'pending', hash: HASH }));

    const result = await transcribeViaBackend(audio(), {
      serverUrl: SERVER, apiKey: 'key', fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 40, pollIntervalMs: 5,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('超时');
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it('maps 401 and network errors to readable messages', async () => {
    const unauthorized = vi.fn().mockResolvedValueOnce(reply(401, { error: 'Unauthorized' }));
    const r401 = await transcribeViaBackend(audio(), { serverUrl: SERVER, apiKey: 'bad', fetchImpl: unauthorized });
    expect(r401.ok).toBe(false);
    if (!r401.ok) expect(r401.error).toContain('API 密钥无效');

    const offline = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const rNet = await transcribeViaBackend(audio(), { serverUrl: SERVER, apiKey: 'key', fetchImpl: offline });
    expect(rNet.ok).toBe(false);
    if (!rNet.ok) expect(rNet.error).toContain('网络错误');
  });
});
