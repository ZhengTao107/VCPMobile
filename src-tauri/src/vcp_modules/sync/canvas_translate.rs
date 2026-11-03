//! 手机 Canvas 二期（ptp4g#39）：文稿翻译的模型请求与译文缓存。
//!
//! 分段、占位符保护、复用、批次解析等逻辑在 `src/core/utils/canvasTranslation.ts`（移植自电脑端
//! `modules/services/canvasTranslation.js`）；这里只做一次模型请求，返回状态码与原始正文，
//! SSE / JSON 的解析和可重试判断在 TS 端完成，与电脑端 canvasTranslationTransport.js 同口径。
//!
//! API Key 只在 Rust 内从设置读取（`read_settings` + `freeze_chat_connection`），不经过前端；
//! 响应正文若回显 Key 会被替换为 `[已隐藏]`。请求体与电脑端 canvasHandlers.js
//! requestCanvasTranslationBatch 一致：temperature 0.15、max_tokens 16384、system=翻译指令、user=编号批文本。
//!
//! 译文缓存：`<support_root>/canvas-mirror/.translations/<文件名>.json`，与镜像目录 `canvas/` 并列，
//! 不会出现在文稿列表或上推范围内。记录内容由前端定义，这里只校验为 JSON 对象并原子写入。

use super::canvas_sync::{
    atomic_write, cancel_request, canvas_client, describe_error, io_err, mirror_root, read_limited,
    register, unregister, validate_name,
};
use crate::vcp_modules::infra::settings_manager::{read_settings, SettingsState};
use crate::vcp_modules::infra::vcp_client::{freeze_chat_connection, ChatRequestPurpose};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

const TRANSLATIONS_DIR: &str = ".translations";
/// 电脑端用 5 分钟空闲超时；reqwest 这里用同样长度的总时限。
const TRANSLATE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 1024 * 1024;
const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;
const TEMPERATURE: f64 = 0.15;
const MAX_TOKENS: u32 = 16_384;
const REDACTED: &str = "[已隐藏]";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateHttpResponse {
    pub status: u16,
    /// 原始响应正文（JSON 或 SSE 文本），已抹去 API Key。
    pub body: String,
    /// 响应超过体积上限时为 true，body 为空。
    pub truncated: bool,
}

fn request_body(model: &str, system: &str, user: &str, stream: bool) -> Value {
    json!({
        "model": model,
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
        "stream": stream,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    })
}

fn redact(text: &str, key: &str) -> String {
    let key = key.trim();
    if key.is_empty() {
        text.to_owned()
    } else {
        text.replace(key, REDACTED)
    }
}

async fn post_translation(
    client: &Client,
    endpoint: &str,
    api_key: &str,
    body: &Value,
    cancel: &CancellationToken,
) -> Result<TranslateHttpResponse, String> {
    let payload = serde_json::to_vec(body).map_err(|e| format!("INVALID_BODY: {e}"))?;
    let mut request = client
        .post(endpoint)
        .header(ACCEPT, "application/json, text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .timeout(TRANSLATE_TIMEOUT)
        .body(payload);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let exchange = async move {
        let response = request.send().await.map_err(describe_error)?;
        let status = response.status().as_u16();
        let bytes = read_limited(response, MAX_RESPONSE_BYTES).await?;
        Ok::<_, String>((status, bytes))
    };
    let (status, bytes) = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err("CANCELLED".to_owned()),
        result = exchange => result.map_err(|e| redact(&e, api_key))?,
    };
    let truncated = bytes.is_none();
    let text = bytes
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    Ok(TranslateHttpResponse {
        status,
        body: redact(&text, api_key),
        truncated,
    })
}

fn record_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    validate_name(name)?;
    Ok(root.join(TRANSLATIONS_DIR).join(format!("{name}.json")))
}

fn load_record(root: &Path, name: &str) -> Result<Option<String>, String> {
    let path = record_path(root, name)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(String::from_utf8(bytes).ok().filter(|text| {
            serde_json::from_str::<Value>(text)
                .map(|value| value.is_object())
                .unwrap_or(false)
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_err(error)),
    }
}

fn save_record(root: &Path, name: &str, record: &str) -> Result<(), String> {
    let path = record_path(root, name)?;
    if record.len() > MAX_RECORD_BYTES {
        return Err("RECORD_TOO_LARGE".to_owned());
    }
    let value: Value = serde_json::from_str(record).map_err(|_| "INVALID_RECORD".to_owned())?;
    if !value.is_object() {
        return Err("INVALID_RECORD".to_owned());
    }
    atomic_write(&path, record.as_bytes())
}

/// 用当前设置的 VCP 地址与 Key 发一次翻译请求；`request_id` 供 [`canvas_translate_cancel`] 中止。
#[tauri::command]
pub async fn canvas_translate_request(
    app: tauri::AppHandle,
    request_id: String,
    model: String,
    system: String,
    user: String,
    stream: Option<bool>,
) -> Result<TranslateHttpResponse, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("MODEL_MISSING".to_owned());
    }
    if system.len() + user.len() > MAX_PROMPT_BYTES {
        return Err("PROMPT_TOO_LARGE".to_owned());
    }
    let settings = read_settings(app.clone(), app.state::<SettingsState>()).await?;
    if settings.vcp_api_key.trim().is_empty() {
        return Err("VCP_NOT_CONFIGURED".to_owned());
    }
    let connection = freeze_chat_connection(&settings, ChatRequestPurpose::Auxiliary)
        .map_err(|e| format!("VCP_NOT_CONFIGURED: {e}"))?;
    let body = request_body(model, &system, &user, stream.unwrap_or(false));
    let cancel = register(&request_id);
    let result = if cancel.is_cancelled() {
        Err("CANCELLED".to_owned())
    } else {
        match canvas_client() {
            Ok(client) => {
                post_translation(
                    client,
                    &connection.endpoint_url,
                    &connection.api_key,
                    &body,
                    &cancel,
                )
                .await
            }
            Err(error) => Err(error),
        }
    };
    unregister(&request_id);
    result
}

/// 中止在途的 [`canvas_translate_request`]；先于请求到达时留下取消标记。
#[tauri::command]
pub async fn canvas_translate_cancel(request_id: String) {
    cancel_request(&request_id);
}

/// 读 `<文件名>` 的译文缓存；不存在或损坏时返回 None。
#[tauri::command]
pub async fn canvas_translation_load(
    app: tauri::AppHandle,
    name: String,
) -> Result<Option<String>, String> {
    load_record(&mirror_root(&app)?, &name)
}

#[tauri::command]
pub async fn canvas_translation_save(
    app: tauri::AppHandle,
    name: String,
    record: String,
) -> Result<(), String> {
    save_record(&mirror_root(&app)?, &name, &record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinHandle;

    fn test_client() -> Client {
        Client::builder().no_proxy().build().unwrap()
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    async fn read_request(socket: &mut TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = socket.read(&mut chunk).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(end) = find(&buffer, b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buffer[..end]).to_ascii_lowercase();
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buffer.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&buffer).into_owned()
    }

    async fn serve_once(status: &str, body: &str) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            socket.write_all(reply.as_bytes()).await.ok();
            socket.shutdown().await.ok();
            request
        });
        (endpoint, handle)
    }

    #[test]
    fn body_matches_desktop_batch_request() {
        let body = request_body("gemini-3.8-flash-tiered", "SYS", "⟦1⟧ Hello", false);
        assert_eq!(body["model"], "gemini-3.8-flash-tiered");
        assert_eq!(body["temperature"], 0.15);
        assert_eq!(body["max_tokens"], 16_384);
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "⟦1⟧ Hello");
    }

    #[test]
    fn redact_hides_key_only_when_present() {
        assert_eq!(
            redact("bad key sk-123 here", "sk-123"),
            "bad key [已隐藏] here"
        );
        assert_eq!(redact("nothing", ""), "nothing");
    }

    #[test]
    fn record_roundtrip_and_validation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(load_record(root, "a.md").unwrap(), None);
        save_record(root, "a.md", r#"{"sourceSha":"x","content":"译文"}"#).unwrap();
        assert!(root.join(".translations").join("a.md.json").is_file());
        assert!(load_record(root, "a.md").unwrap().unwrap().contains("译文"));
        assert_eq!(
            save_record(root, "a.md", "[1]").unwrap_err(),
            "INVALID_RECORD"
        );
        assert_eq!(
            save_record(root, "a.md", "{oops").unwrap_err(),
            "INVALID_RECORD"
        );
        assert!(save_record(root, "../x.md", "{}").is_err());
        std::fs::write(root.join(".translations").join("b.md.json"), "not json").unwrap();
        assert_eq!(load_record(root, "b.md").unwrap(), None);
    }

    #[tokio::test]
    async fn post_sends_bearer_json_and_returns_raw_body() {
        let reply = r#"{"choices":[{"message":{"content":"⟦1⟧ 你好"},"finish_reason":"stop"}]}"#;
        let (endpoint, server) = serve_once("200 OK", reply).await;
        let body = request_body("m", "SYS", "⟦1⟧ Hello", false);
        let result = post_translation(
            &test_client(),
            &endpoint,
            "sk-test",
            &body,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let request = server.await.unwrap();
        let lower = request.to_ascii_lowercase();
        assert!(
            request.starts_with("POST /v1/chat/completions "),
            "{request}"
        );
        assert!(lower.contains("authorization: bearer sk-test"));
        assert!(lower.contains("content-type: application/json"));
        assert!(request.contains(r#""temperature":0.15"#));
        assert_eq!(result.status, 200);
        assert_eq!(result.body, reply);
        assert!(!result.truncated);
    }

    #[tokio::test]
    async fn error_body_echoing_key_is_redacted() {
        let (endpoint, server) = serve_once(
            "401 Unauthorized",
            r#"{"error":{"message":"bad key sk-test"}}"#,
        )
        .await;
        let body = request_body("m", "S", "U", false);
        let result = post_translation(
            &test_client(),
            &endpoint,
            "sk-test",
            &body,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(result.status, 401);
        assert!(!result.body.contains("sk-test"));
        assert!(result.body.contains(REDACTED));
    }

    #[tokio::test]
    async fn cancel_aborts_hanging_translation() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let hold = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(socket);
        });
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            trigger.cancel();
        });
        let body = request_body("m", "S", "U", false);
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            post_translation(&test_client(), &endpoint, "k", &body, &cancel),
        )
        .await
        .expect("cancel should end request");
        assert_eq!(result.unwrap_err(), "CANCELLED");
        hold.abort();
    }

    #[tokio::test]
    async fn cancel_before_request_is_honoured() {
        cancel_request("translate-test-early");
        let token = register("translate-test-early");
        assert!(token.is_cancelled());
        unregister("translate-test-early");
        canvas_translate_cancel("translate-test-unused".to_owned()).await;
    }
}
