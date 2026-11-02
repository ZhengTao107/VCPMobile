//! 订阅电脑端 VCPMobileSyncHint 的数据变化提示（ptp4g#29）。
//!
//! 只负责一次带超时、可取消的长轮询 GET，把 HTTP 状态码与 JSON 原样交回前端；
//! 游标、退避与触发同步的策略都在 `src/core/sync/remoteChangeHint.ts`。
//!
//! 不在 WebView 里直接 fetch：iOS ATS 只放行局域网，Android release 包的 cleartext
//! 取决于 trustedLanMode 打包开关，插件也不保证回 CORS 头，三处都可能拦住
//! `http://公网:5974`。同步数据面本来就用 reqwest 访问同一个 syncHttpUrl。
//!
//! Client 归属：与 sync 子系统其他部分一样自持专职 Client（见 infra/http_clients.rs
//! 规矩 4）；长轮询需要请求级总超时，空闲连接 60s 淘汰以适应 WiFi↔蜂窝切换。

use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const WAIT_PATH: &str = "/api/mobile-sync-hint/wait";
const DEFAULT_WAIT_MS: u64 = 25_000;
const MIN_WAIT_MS: u64 = 1_000;
const MAX_WAIT_MS: u64 = 60_000;
/// 服务端挂起时长之外留给建连与往返的余量；超出即判超时。
const REQUEST_GRACE: Duration = Duration::from_secs(15);
const MAX_BODY_BYTES: usize = 64 * 1024;
/// 未被 wait 认领的取消标记超过此数量时清理一次。
const MAX_TOMBSTONES: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHintResponse {
    pub status: u16,
    /// 响应体按 JSON 解析的结果；非 JSON 或超过体积上限时为 `None`。
    pub body: Option<Value>,
}

fn hint_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .pool_idle_timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| format!("CLIENT_INIT: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// 在途请求的取消令牌。cancel 先于 wait 到达时留下已取消的令牌，wait 读到后立即返回。
fn registry() -> MutexGuard<'static, HashMap<String, CancellationToken>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    REGISTRY
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn register(request_id: &str) -> CancellationToken {
    registry()
        .entry(request_id.to_owned())
        .or_insert_with(CancellationToken::new)
        .clone()
}

fn unregister(request_id: &str) {
    registry().remove(request_id);
}

fn cancel_request(request_id: &str) {
    let mut map = registry();
    if !map.contains_key(request_id) && map.len() >= MAX_TOMBSTONES {
        map.retain(|_, token| !token.is_cancelled());
    }
    map.entry(request_id.to_owned())
        .or_insert_with(CancellationToken::new)
        .cancel();
}

fn build_wait_url(
    base_url: &str,
    since: Option<u64>,
    instance: Option<&str>,
    timeout_ms: u64,
) -> Result<Url, String> {
    let base = base_url.trim().trim_end_matches('/');
    let raw = format!("{base}{WAIT_PATH}");
    let mut url = Url::parse(&raw).map_err(|e| format!("INVALID_URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("INVALID_URL: unsupported scheme {}", url.scheme()));
    }
    {
        let mut query = url.query_pairs_mut();
        if let Some(since) = since {
            query.append_pair("since", &since.to_string());
        }
        if let Some(instance) = instance.filter(|value| !value.is_empty()) {
            query.append_pair("instance", instance);
        }
        query.append_pair("timeoutMs", &timeout_ms.to_string());
    }
    Ok(url)
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

async fn wait_once(
    client: &Client,
    url: Url,
    token: &str,
    timeout_ms: u64,
    cancel: &CancellationToken,
) -> Result<SyncHintResponse, String> {
    let request = client
        .get(url)
        .bearer_auth(token)
        .header(ACCEPT, "application/json")
        .timeout(Duration::from_millis(timeout_ms) + REQUEST_GRACE);
    let exchange = async move {
        let mut response = request.send().await.map_err(describe_error)?;
        let status = response.status().as_u16();
        let mut buffer = Vec::new();
        let mut oversized = false;
        while let Some(chunk) = response.chunk().await.map_err(describe_error)? {
            if buffer.len() + chunk.len() > MAX_BODY_BYTES {
                oversized = true;
                break;
            }
            buffer.extend_from_slice(&chunk);
        }
        let body = if oversized {
            None
        } else {
            serde_json::from_slice(&buffer).ok()
        };
        Ok(SyncHintResponse { status, body })
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("CANCELLED".to_owned()),
        result = exchange => result,
    }
}

/// 发起一次长轮询；`request_id` 供 [`sync_hint_cancel`] 中止。
#[tauri::command]
pub async fn sync_hint_wait(
    request_id: String,
    base_url: String,
    token: String,
    since: Option<u64>,
    instance: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<SyncHintResponse, String> {
    let timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_WAIT_MS)
        .clamp(MIN_WAIT_MS, MAX_WAIT_MS);
    let token = token.trim();
    if token.is_empty() {
        return Err("TOKEN_MISSING".to_owned());
    }
    let url = build_wait_url(&base_url, since, instance.as_deref(), timeout_ms)?;
    let client = hint_client()?;
    let cancel = register(&request_id);
    let result = if cancel.is_cancelled() {
        Err("CANCELLED".to_owned())
    } else {
        wait_once(client, url, token, timeout_ms, &cancel).await
    };
    unregister(&request_id);
    result
}

/// 中止在途的 [`sync_hint_wait`]；先于 wait 到达时留下取消标记，wait 随后立即返回。
#[tauri::command]
pub async fn sync_hint_cancel(request_id: String) {
    cancel_request(&request_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    fn test_client() -> Client {
        Client::builder().no_proxy().build().unwrap()
    }

    /// 单连接 HTTP 桩：读一次请求头；`reply` 为 None 时挂住不回，模拟长轮询。
    async fn serve_once(reply: Option<String>) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0u8; 8192];
            let read = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
            match reply {
                Some(reply) => {
                    socket.write_all(reply.as_bytes()).await.unwrap();
                    socket.shutdown().await.ok();
                }
                None => tokio::time::sleep(Duration::from_secs(30)).await,
            }
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
    fn first_call_url_has_no_cursor() {
        let base = " http://sync.example:5974/ ";
        let url = build_wait_url(base, None, None, 25_000).unwrap();
        let expected = "http://sync.example:5974/api/mobile-sync-hint/wait?timeoutMs=25000";
        assert_eq!(url.as_str(), expected);
    }

    #[test]
    fn cursor_is_encoded_into_query() {
        let base = "https://h.example/base";
        let url = build_wait_url(base, Some(42), Some("a b&c"), 1_000).unwrap();
        let expected =
            "https://h.example/base/api/mobile-sync-hint/wait?since=42&instance=a+b%26c&timeoutMs=1000";
        assert_eq!(url.as_str(), expected);
    }

    #[test]
    fn rejects_non_http_base() {
        let ws = build_wait_url("ws://h.example:5975", None, None, 1_000);
        assert!(ws.unwrap_err().starts_with("INVALID_URL"));
        let garbage = build_wait_url("not a url", None, None, 1_000);
        assert!(garbage.unwrap_err().starts_with("INVALID_URL"));
    }

    #[tokio::test]
    async fn returns_status_and_json_with_bearer_token() {
        let body = r#"{"instanceId":"inst-1","revision":7,"changed":true}"#;
        let (base, server) = serve_once(Some(reply("200 OK", body))).await;
        let url = build_wait_url(&base, Some(6), Some("inst-1"), 1_000).unwrap();
        let cancel = CancellationToken::new();
        let client = test_client();
        let result = wait_once(&client, url, "test-token", 1_000, &cancel).await;
        let expected: Value = serde_json::from_str(body).unwrap();
        assert_eq!(
            result.unwrap(),
            SyncHintResponse {
                status: 200,
                body: Some(expected),
            }
        );
        let request = server.await.unwrap().to_ascii_lowercase();
        let line = "get /api/mobile-sync-hint/wait?since=6&instance=inst-1&timeoutms=1000 ";
        assert!(request.starts_with(line));
        assert!(request.contains("authorization: bearer test-token\r\n"));
    }

    #[tokio::test]
    async fn non_json_error_body_keeps_status() {
        let (base, server) = serve_once(Some(reply("404 Not Found", "not found"))).await;
        let url = build_wait_url(&base, None, None, 1_000).unwrap();
        let cancel = CancellationToken::new();
        let client = test_client();
        let result = wait_once(&client, url, "test-token", 1_000, &cancel).await;
        assert_eq!(
            result.unwrap(),
            SyncHintResponse {
                status: 404,
                body: None,
            }
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancel_aborts_a_hanging_request() {
        let (base, server) = serve_once(None).await;
        let url = build_wait_url(&base, None, None, 1_000).unwrap();
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            trigger.cancel();
        });
        let client = test_client();
        let result = wait_once(&client, url, "test-token", 1_000, &cancel).await;
        assert_eq!(result, Err("CANCELLED".to_owned()));
        server.abort();
    }

    #[tokio::test]
    async fn cancel_before_wait_returns_immediately_and_clears_registry() {
        let id = "hint-test-early";
        cancel_request(id);
        let result = sync_hint_wait(
            id.to_owned(),
            "http://127.0.0.1:9".to_owned(),
            "test-token".to_owned(),
            None,
            None,
            None,
        )
        .await;
        assert_eq!(result, Err("CANCELLED".to_owned()));
        assert!(!registry().contains_key(id));
    }

    #[tokio::test]
    async fn blank_token_is_rejected_before_network() {
        let result = sync_hint_wait(
            "hint-test-blank".to_owned(),
            "http://127.0.0.1:9".to_owned(),
            "  ".to_owned(),
            None,
            None,
            None,
        )
        .await;
        assert_eq!(result, Err("TOKEN_MISSING".to_owned()));
    }
}
