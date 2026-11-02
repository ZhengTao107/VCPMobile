//! 设置同步（ptp4g#37）的客户端通道：GET / PUT `{syncHttpUrl}/api/canvas-sync/settings`。
//!
//! 只做一次带总超时与体积上限的请求，把 HTTP 状态码与 JSON 原样交回前端；
//! 白名单取舍、明暗映射、上推防抖与 404/503 退避都在 `src/core/sync/settingsRemote.ts`。
//! 通道写法同 [`super::open_tabs`]：走 reqwest 而不是 WebView fetch（iOS ATS、
//! Android release cleartext 开关、插件不保证 CORS）。

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, Method, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

const SETTINGS_PATH: &str = "/api/canvas-sync/settings";
/// 建连到读完响应体的总时限。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 响应体与上推请求体的体积上限。
const MAX_BODY_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSyncResponse {
    pub status: u16,
    /// 响应体按 JSON 解析的结果；空体、非 JSON 或超过体积上限时为 `None`。
    pub body: Option<Value>,
}

fn settings_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(REQUEST_TIMEOUT)
                .pool_idle_timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| format!("CLIENT_INIT: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn settings_url(base_url: &str) -> Result<Url, String> {
    let base = base_url.trim().trim_end_matches('/');
    let url =
        Url::parse(&format!("{base}{SETTINGS_PATH}")).map_err(|e| format!("INVALID_URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("INVALID_URL: unsupported scheme {}", url.scheme()));
    }
    Ok(url)
}

fn require_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.is_empty() {
        Err("TOKEN_MISSING".to_owned())
    } else {
        Ok(token)
    }
}

/// PUT 体固定为 `{values: object}`，与电脑端契约一致；白名单由电脑端再过滤一次。
fn put_payload(values: Value) -> Result<Vec<u8>, String> {
    if !values.is_object() {
        return Err("INVALID_BODY: values must be an object".to_owned());
    }
    let payload = serde_json::to_vec(&json!({ "values": values }))
        .map_err(|e| format!("INVALID_BODY: {e}"))?;
    if payload.len() > MAX_BODY_BYTES {
        return Err("BODY_TOO_LARGE".to_owned());
    }
    Ok(payload)
}

fn describe_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "TIMEOUT".to_owned()
    } else if error.is_connect() {
        format!("CONNECT: {error}")
    } else {
        format!("NETWORK: {error}")
    }
}

async fn exchange(
    client: &Client,
    method: Method,
    url: Url,
    token: &str,
    body: Option<Vec<u8>>,
) -> Result<SettingsSyncResponse, String> {
    let mut request = client
        .request(method, url)
        .bearer_auth(token)
        .header(ACCEPT, "application/json")
        .timeout(REQUEST_TIMEOUT);
    if let Some(body) = body {
        request = request.header(CONTENT_TYPE, "application/json").body(body);
    }
    let mut response = request.send().await.map_err(describe_error)?;
    let status = response.status().as_u16();
    let mut buffer = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(describe_error)? {
        if buffer.len() + chunk.len() > MAX_BODY_BYTES {
            return Ok(SettingsSyncResponse { status, body: None });
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok(SettingsSyncResponse {
        status,
        body: serde_json::from_slice(&buffer).ok(),
    })
}

/// 读取电脑端白名单设置：`{revision, values}`。
#[tauri::command]
pub async fn settings_sync_get(
    base_url: String,
    token: String,
) -> Result<SettingsSyncResponse, String> {
    let token = require_token(&token)?;
    let url = settings_url(&base_url)?;
    exchange(settings_client()?, Method::GET, url, token, None).await
}

/// 上推手机侧变化的键；`values` 原样包成 `{values}` 转发。
#[tauri::command]
pub async fn settings_sync_put(
    base_url: String,
    token: String,
    values: Value,
) -> Result<SettingsSyncResponse, String> {
    let token = require_token(&token)?;
    let url = settings_url(&base_url)?;
    let payload = put_payload(values)?;
    exchange(settings_client()?, Method::PUT, url, token, Some(payload)).await
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

    async fn serve_once(reply: String) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            socket.write_all(reply.as_bytes()).await.ok();
            socket.shutdown().await.ok();
            request
        });
        (base, handle)
    }

    fn reply(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn url_trims_base_and_appends_contract_path() {
        let url = settings_url(" https://h.example/base/ ").unwrap();
        assert_eq!(
            url.as_str(),
            "https://h.example/base/api/canvas-sync/settings"
        );
        assert!(settings_url("ws://h.example")
            .unwrap_err()
            .starts_with("INVALID_URL"));
        assert!(settings_url("not a url")
            .unwrap_err()
            .starts_with("INVALID_URL"));
    }

    #[test]
    fn put_payload_wraps_object_and_rejects_others() {
        let bytes = put_payload(json!({"userName": "凌"})).unwrap();
        let sent: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(sent, json!({"values": {"userName": "凌"}}));
        for bad in [json!([]), json!("x"), Value::Null] {
            assert!(put_payload(bad).unwrap_err().starts_with("INVALID_BODY"));
        }
        let large = put_payload(json!({ "userName": "x".repeat(MAX_BODY_BYTES) }));
        assert_eq!(large, Err("BODY_TOO_LARGE".to_owned()));
    }

    #[tokio::test]
    async fn get_returns_status_and_json_with_bearer_token() {
        let body = r#"{"revision":"r1","values":{"currentThemeMode":"dark"}}"#;
        let (base, server) = serve_once(reply("200 OK", body)).await;
        let url = settings_url(&base).unwrap();
        let result = exchange(&test_client(), Method::GET, url, "test-token", None).await;
        assert_eq!(
            result.unwrap(),
            SettingsSyncResponse {
                status: 200,
                body: Some(serde_json::from_str(body).unwrap()),
            }
        );
        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /api/canvas-sync/settings "));
        assert!(request.contains("authorization: bearer test-token\r\n"));
    }

    #[tokio::test]
    async fn put_sends_wrapped_values() {
        let (base, server) = serve_once(reply("200 OK", r#"{"values":{}}"#)).await;
        let url = settings_url(&base).unwrap();
        let bytes = put_payload(json!({"currentThemeMode": "light"})).unwrap();
        let result = exchange(&test_client(), Method::PUT, url, "test-token", Some(bytes)).await;
        assert_eq!(result.unwrap().status, 200);
        let request = server.await.unwrap();
        let lower = request.to_ascii_lowercase();
        assert!(lower.starts_with("put /api/canvas-sync/settings "));
        assert!(lower.contains("content-type: application/json\r\n"));
        let sent = &request[request.find("\r\n\r\n").unwrap() + 4..];
        assert_eq!(
            serde_json::from_str::<Value>(sent).unwrap(),
            json!({"values": {"currentThemeMode": "light"}})
        );
    }

    #[tokio::test]
    async fn not_found_keeps_status_without_json() {
        let (base, server) = serve_once(reply("404 Not Found", "not found")).await;
        let url = settings_url(&base).unwrap();
        let result = exchange(&test_client(), Method::GET, url, "test-token", None).await;
        assert_eq!(
            result.unwrap(),
            SettingsSyncResponse {
                status: 404,
                body: None,
            }
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_blank_token_and_bad_values_before_network() {
        let blank = settings_sync_get("http://127.0.0.1:9".to_owned(), "  ".to_owned()).await;
        assert_eq!(blank, Err("TOKEN_MISSING".to_owned()));
        let bad = settings_sync_put(
            "http://127.0.0.1:9".to_owned(),
            "test-token".to_owned(),
            json!([1]),
        )
        .await;
        assert!(bad.unwrap_err().starts_with("INVALID_BODY"));
    }
}
