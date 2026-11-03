//! 三端互看已打开标签（ptp4g#36，方案 B：只看不改）的客户端通道。
//!
//! 只做一次带总超时与体积上限的 GET / PUT，把 HTTP 状态码与 JSON 原样交回前端；
//! 过滤本机、离线显示、上报防抖与 404/503 降级都在 `src/core/sync/openTabsRemote.ts`。
//! 走 reqwest 而不是 WebView fetch，原因同 [`super::sync_hint`]：iOS ATS、
//! Android release cleartext 开关、插件不保证 CORS。

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, Method, Url};
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

const SNAPSHOT_PATH: &str = "/api/open-tabs/snapshot";
const DEVICE_PATH: &str = "/api/open-tabs/device/";
/// 建连到读完响应体的总时限。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 响应体与上报请求体的体积上限。
const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_DEVICE_ID_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTabsResponse {
    pub status: u16,
    /// 响应体按 JSON 解析的结果；空体、非 JSON 或超过体积上限时为 `None`。
    pub body: Option<Value>,
}

fn open_tabs_client() -> Result<&'static Client, String> {
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

/// 与前端同一规则：`^[A-Za-z0-9_-]{1,64}$`，保证可直接拼进路径。
fn is_valid_device_id(device_id: &str) -> bool {
    !device_id.is_empty()
        && device_id.len() <= MAX_DEVICE_ID_LEN
        && device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn build_url(base_url: &str, path: &str) -> Result<Url, String> {
    let base = base_url.trim().trim_end_matches('/');
    let url = Url::parse(&format!("{base}{path}")).map_err(|e| format!("INVALID_URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("INVALID_URL: unsupported scheme {}", url.scheme()));
    }
    Ok(url)
}

fn snapshot_url(base_url: &str) -> Result<Url, String> {
    build_url(base_url, SNAPSHOT_PATH)
}

fn device_url(base_url: &str, device_id: &str) -> Result<Url, String> {
    if !is_valid_device_id(device_id) {
        return Err("INVALID_DEVICE_ID".to_owned());
    }
    build_url(base_url, &format!("{DEVICE_PATH}{device_id}"))
}

fn require_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.is_empty() {
        Err("TOKEN_MISSING".to_owned())
    } else {
        Ok(token)
    }
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
) -> Result<OpenTabsResponse, String> {
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
            return Ok(OpenTabsResponse { status, body: None });
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok(OpenTabsResponse {
        status,
        body: serde_json::from_slice(&buffer).ok(),
    })
}

/// 读取所有设备的已打开标签快照（前端负责过滤本机）。
#[tauri::command]
pub async fn open_tabs_get(base_url: String, token: String) -> Result<OpenTabsResponse, String> {
    let token = require_token(&token)?;
    let url = snapshot_url(&base_url)?;
    exchange(open_tabs_client()?, Method::GET, url, token, None).await
}

/// 上报本机已打开标签；`body` 为 `{deviceName, kind, tabs}`，原样转发。
#[tauri::command]
pub async fn open_tabs_put(
    base_url: String,
    token: String,
    device_id: String,
    body: Value,
) -> Result<OpenTabsResponse, String> {
    let token = require_token(&token)?;
    let url = device_url(&base_url, &device_id)?;
    let payload = serde_json::to_vec(&body).map_err(|e| format!("INVALID_BODY: {e}"))?;
    if payload.len() > MAX_BODY_BYTES {
        return Err("BODY_TOO_LARGE".to_owned());
    }
    exchange(open_tabs_client()?, Method::PUT, url, token, Some(payload)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinHandle;

    fn test_client() -> Client {
        Client::builder().no_proxy().build().unwrap()
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    /// 读完整个请求（头 + Content-Length 指定的体）。
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
    fn urls_trim_base_and_append_contract_paths() {
        let snapshot = snapshot_url(" http://sync.example:5974/ ").unwrap();
        assert_eq!(
            snapshot.as_str(),
            "http://sync.example:5974/api/open-tabs/snapshot"
        );
        let device = device_url("https://h.example/base/", "android-a1_B2").unwrap();
        assert_eq!(
            device.as_str(),
            "https://h.example/base/api/open-tabs/device/android-a1_B2"
        );
    }

    #[test]
    fn device_id_must_match_contract_pattern() {
        let too_long = "a".repeat(65);
        for bad in ["", "a/b", "a b", "..", "名字", too_long.as_str()] {
            let error = device_url("http://h.example", bad).unwrap_err();
            assert_eq!(error, "INVALID_DEVICE_ID", "{bad:?}");
        }
        assert!(device_url("http://h.example", &"a".repeat(64)).is_ok());
    }

    #[test]
    fn rejects_non_http_base() {
        assert!(snapshot_url("ws://h.example:5975")
            .unwrap_err()
            .starts_with("INVALID_URL"));
        assert!(snapshot_url("not a url")
            .unwrap_err()
            .starts_with("INVALID_URL"));
    }

    #[tokio::test]
    async fn get_returns_status_and_json_with_bearer_token() {
        let body = r#"{"revision":3,"devices":[]}"#;
        let (base, server) = serve_once(reply("200 OK", body)).await;
        let url = snapshot_url(&base).unwrap();
        let result = exchange(&test_client(), Method::GET, url, "test-token", None).await;
        assert_eq!(
            result.unwrap(),
            OpenTabsResponse {
                status: 200,
                body: Some(serde_json::from_str(body).unwrap()),
            }
        );
        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /api/open-tabs/snapshot "));
        assert!(request.contains("authorization: bearer test-token\r\n"));
    }

    #[tokio::test]
    async fn put_sends_json_body_to_device_path() {
        let (base, server) = serve_once(reply("200 OK", r#"{"ok":true}"#)).await;
        let url = device_url(&base, "android-1").unwrap();
        let payload = json!({"deviceName": "手机", "kind": "android", "tabs": []});
        let bytes = serde_json::to_vec(&payload).unwrap();
        let result = exchange(&test_client(), Method::PUT, url, "test-token", Some(bytes)).await;
        assert_eq!(result.unwrap().status, 200);
        let request = server.await.unwrap();
        let lower = request.to_ascii_lowercase();
        assert!(lower.starts_with("put /api/open-tabs/device/android-1 "));
        assert!(lower.contains("content-type: application/json\r\n"));
        let sent = &request[request.find("\r\n\r\n").unwrap() + 4..];
        assert_eq!(serde_json::from_str::<Value>(sent).unwrap(), payload);
    }

    #[tokio::test]
    async fn not_found_keeps_status_without_json() {
        let (base, server) = serve_once(reply("404 Not Found", "not found")).await;
        let url = snapshot_url(&base).unwrap();
        let result = exchange(&test_client(), Method::GET, url, "test-token", None).await;
        assert_eq!(
            result.unwrap(),
            OpenTabsResponse {
                status: 404,
                body: None,
            }
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_body_is_dropped_but_status_kept() {
        let big = format!("[\"{}\"]", "a".repeat(MAX_BODY_BYTES + 1024));
        let (base, server) = serve_once(reply("200 OK", &big)).await;
        let url = snapshot_url(&base).unwrap();
        let result = exchange(&test_client(), Method::GET, url, "test-token", None).await;
        assert_eq!(
            result.unwrap(),
            OpenTabsResponse {
                status: 200,
                body: None,
            }
        );
        server.abort();
    }

    #[tokio::test]
    async fn rejects_blank_token_and_bad_device_before_network() {
        let blank = open_tabs_get("http://127.0.0.1:9".to_owned(), "  ".to_owned()).await;
        assert_eq!(blank, Err("TOKEN_MISSING".to_owned()));
        let bad = open_tabs_put(
            "http://127.0.0.1:9".to_owned(),
            "test-token".to_owned(),
            "a/b".to_owned(),
            json!({}),
        )
        .await;
        assert_eq!(bad, Err("INVALID_DEVICE_ID".to_owned()));
        let large = open_tabs_put(
            "http://127.0.0.1:9".to_owned(),
            "test-token".to_owned(),
            "android-1".to_owned(),
            json!({ "tabs": "x".repeat(MAX_BODY_BYTES) }),
        )
        .await;
        assert_eq!(large, Err("BODY_TOO_LARGE".to_owned()));
    }
}
