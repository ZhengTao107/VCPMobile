//! 手机 Canvas 一期（ptp4g#9）：电脑端 VCPCanvasSync（`/api/canvas-sync`）的客户端通道与本地镜像。
//!
//! 网络部分只做带总超时、体积上限的单次请求，把 HTTP 状态码与 JSON 原样交回前端；
//! 同步决策（拉/推/冲突副本）、wait 订阅生命周期与 404/503 降级都在 `src/core/stores/canvasStore.ts`。
//! 走 reqwest 而不是 WebView fetch，原因同 [`super::sync_hint`]。
//!
//! 本地镜像：`<support_root>/canvas-mirror/canvas/<name>` 存正文，`canvas-mirror/state.json`
//! 记录每个文件最后一次与电脑端一致时的 sha256（baseSha）。一期只镜像 canvas 根下的 .md/.txt；
//! 名字含 `.bak`/`.conflict-` 的是本地副本，电脑端同样排除，这里拒绝上推。

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

const API_PREFIX: &str = "/api/canvas-sync";
const SCOPE_DIR: &str = "canvas";
const MIRROR_DIR: &str = "canvas-mirror";
const STATE_FILE: &str = "state.json";
/// JSON 接口建连到读完响应体的总时限。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// 文稿正文拉取/上推的总时限。
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_WAIT_MS: u64 = 25_000;
const MIN_WAIT_MS: u64 = 1_000;
const MAX_WAIT_MS: u64 = 60_000;
/// 服务端挂起时长之外留给建连与往返的余量。
const WAIT_GRACE: Duration = Duration::from_secs(15);
const MAX_TOMBSTONES: usize = 256;
const MAX_NAME_BYTES: usize = 255;
const CONFLICT_TAG: &str = ".conflict-手机-";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasHttpResponse {
    pub status: u16,
    /// 响应体按 JSON 解析的结果；空体、非 JSON 或超过体积上限时为 `None`。
    pub body: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasTransferResult {
    pub status: u16,
    /// 成功时为本地镜像现在的 sha256（同时已记为 baseSha）。
    pub sha256: Option<String>,
    /// 非 200 时电脑端返回的 JSON（409 带 `serverSha`）。
    pub body: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasLocalEntry {
    pub name: String,
    pub size: u64,
    pub mtime: u64,
    pub sha256: String,
    pub base_sha: Option<String>,
    /// 冲突副本等只留本机、不参与同步的文件。
    pub local_only: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct MirrorState {
    #[serde(default)]
    base: BTreeMap<String, String>,
}

pub(super) fn canvas_client() -> Result<&'static Client, String> {
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

// ---------------------------------------------------------------- 名称与 URL

/// 与电脑端 parseScopedPath 同口径：canvas 根下单层文件名，拒绝分隔符、盘符/ADS 冒号、
/// "."/".."、Windows 会裁掉的末尾点或空格；一期只收 .md/.txt。
pub(super) fn validate_name(name: &str) -> Result<(), String> {
    let malformed = name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '\0'])
        || name.ends_with('.')
        || name.ends_with(' ');
    if malformed {
        return Err("INVALID_NAME".to_owned());
    }
    let lower = name.to_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".txt")) {
        return Err("UNSUPPORTED_EXTENSION".to_owned());
    }
    Ok(())
}

fn is_local_only(name: &str) -> bool {
    name.contains(".bak") || name.contains(".conflict-")
}

fn scoped_path(name: &str) -> String {
    format!("{SCOPE_DIR}/{name}")
}

fn api_url(base_url: &str, route: &str, query: &[(&str, &str)]) -> Result<Url, String> {
    let base = base_url.trim().trim_end_matches('/');
    let mut url = Url::parse(&format!("{base}{API_PREFIX}{route}"))
        .map_err(|e| format!("INVALID_URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("INVALID_URL: unsupported scheme {}", url.scheme()));
    }
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
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

pub(super) fn describe_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "TIMEOUT".to_owned()
    } else if error.is_connect() {
        format!("CONNECT: {error}")
    } else {
        format!("NETWORK: {error}")
    }
}

/// 读完响应体；超过 `limit` 返回 `None`（状态码由调用方保留）。
pub(super) async fn read_limited(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut buffer = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(describe_error)? {
        if buffer.len() + chunk.len() > limit {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk);
    }
    Ok(Some(buffer))
}

async fn read_json(response: reqwest::Response) -> Result<Option<Value>, String> {
    Ok(read_limited(response, MAX_JSON_BYTES)
        .await?
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()))
}

async fn json_exchange(
    client: &Client,
    method: Method,
    url: Url,
    token: &str,
    body: Option<Vec<u8>>,
) -> Result<CanvasHttpResponse, String> {
    let mut request = client
        .request(method, url)
        .bearer_auth(token)
        .header(ACCEPT, "application/json")
        .timeout(REQUEST_TIMEOUT);
    if let Some(body) = body {
        request = request.header(CONTENT_TYPE, "application/json").body(body);
    }
    let response = request.send().await.map_err(describe_error)?;
    let status = response.status().as_u16();
    Ok(CanvasHttpResponse {
        status,
        body: read_json(response).await?,
    })
}

// ---------------------------------------------------------------- 本地镜像

pub(super) fn io_err(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "NOT_FOUND".to_owned()
    } else {
        format!("IO: {error}")
    }
}

fn sha_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn file_path(root: &Path, name: &str) -> PathBuf {
    root.join(SCOPE_DIR).join(name)
}

/// 同目录临时文件 + rename，避免写到一半的正文被读到。
pub(super) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = target.parent().ok_or_else(|| "INVALID_PATH".to_owned())?;
    std::fs::create_dir_all(dir).map_err(io_err)?;
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".canvas-{}-{seq}.tmp", std::process::id()));
    if let Err(error) = std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, target)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(io_err(error));
    }
    Ok(())
}

/// state.json 的读改写串行化；只包住同步 IO，不跨 await。
fn state_guard() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 缺失或损坏时视为空：最坏情况是下次同步把全部文件当作"本机新建"，由冲突流程兜底。
fn load_state(root: &Path) -> MirrorState {
    std::fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn base_of(root: &Path, name: &str) -> Option<String> {
    let _guard = state_guard();
    load_state(root).base.get(name).cloned()
}

fn set_base(root: &Path, name: &str, sha: &str) -> Result<(), String> {
    let _guard = state_guard();
    let mut state = load_state(root);
    state.base.insert(name.to_owned(), sha.to_owned());
    let bytes = serde_json::to_vec(&state).map_err(|e| format!("STATE_ENCODE: {e}"))?;
    atomic_write(&root.join(STATE_FILE), &bytes)
}

fn list_local(root: &Path) -> Result<Vec<CanvasLocalEntry>, String> {
    let dir = root.join(SCOPE_DIR);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_err(error)),
    };
    let base = {
        let _guard = state_guard();
        load_state(root).base
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate_name(&name).is_err() {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(CanvasLocalEntry {
            local_only: is_local_only(&name),
            base_sha: base.get(&name).cloned(),
            sha256: sha_hex(&bytes),
            size: bytes.len() as u64,
            mtime,
            name,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn read_local(root: &Path, name: &str) -> Result<String, String> {
    validate_name(name)?;
    let bytes = std::fs::read(file_path(root, name)).map_err(io_err)?;
    String::from_utf8(bytes).map_err(|_| "NOT_UTF8".to_owned())
}

/// 写本机正文，返回新 sha；不改 baseSha（是否上推由同步决定）。
fn write_local(root: &Path, name: &str, content: &str) -> Result<String, String> {
    validate_name(name)?;
    if content.len() > MAX_FILE_BYTES {
        return Err("FILE_TOO_LARGE".to_owned());
    }
    atomic_write(&file_path(root, name), content.as_bytes())?;
    Ok(sha_hex(content.as_bytes()))
}

fn conflict_name(name: &str, stamp: u64, attempt: u32) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(index) => (&name[..index], &name[index..]),
        None => (name, ""),
    };
    let suffix = if attempt == 0 {
        String::new()
    } else {
        format!("-{attempt}")
    };
    format!("{stem}{CONFLICT_TAG}{stamp}{suffix}{ext}")
}

/// 把本机当前正文另存为 `<stem>.conflict-手机-<秒>.<ext>`，返回副本名。
fn save_conflict(root: &Path, name: &str) -> Result<String, String> {
    validate_name(name)?;
    let bytes = std::fs::read(file_path(root, name)).map_err(io_err)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for attempt in 0..100 {
        let candidate = conflict_name(name, stamp, attempt);
        validate_name(&candidate)?;
        let target = file_path(root, &candidate);
        if !target.exists() {
            atomic_write(&target, &bytes)?;
            return Ok(candidate);
        }
    }
    Err("CONFLICT_NAME_EXHAUSTED".to_owned())
}

// ---------------------------------------------------------------- 拉取与上推

/// 拉取电脑端正文覆盖本机镜像并记 baseSha。`expected` 与本机现有正文一致时只记 baseSha，不走网络。
async fn pull(
    client: &Client,
    root: &Path,
    base_url: &str,
    token: &str,
    name: &str,
    expected: Option<&str>,
) -> Result<CanvasTransferResult, String> {
    validate_name(name)?;
    let target = file_path(root, name);
    if let Some(expected) = expected {
        if let Ok(bytes) = std::fs::read(&target) {
            if sha_hex(&bytes) == expected {
                set_base(root, name, expected)?;
                return Ok(CanvasTransferResult {
                    status: 200,
                    sha256: Some(expected.to_owned()),
                    body: None,
                });
            }
        }
    }
    let path = scoped_path(name);
    let url = api_url(base_url, "/file", &[("path", &path)])?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .timeout(TRANSFER_TIMEOUT)
        .send()
        .await
        .map_err(describe_error)?;
    let status = response.status().as_u16();
    if status != 200 {
        return Ok(CanvasTransferResult {
            status,
            sha256: None,
            body: read_json(response).await?,
        });
    }
    let bytes = read_limited(response, MAX_FILE_BYTES)
        .await?
        .ok_or_else(|| "FILE_TOO_LARGE".to_owned())?;
    let sha = sha_hex(&bytes);
    atomic_write(&target, &bytes)?;
    set_base(root, name, &sha)?;
    Ok(CanvasTransferResult {
        status,
        sha256: Some(sha),
        body: None,
    })
}

/// 以 baseSha 做乐观并发上推本机正文；200 后把推上去的 sha 记为 baseSha，409 不动 baseSha。
async fn push(
    client: &Client,
    root: &Path,
    base_url: &str,
    token: &str,
    name: &str,
) -> Result<CanvasTransferResult, String> {
    validate_name(name)?;
    if is_local_only(name) {
        return Err("LOCAL_ONLY".to_owned());
    }
    let bytes = std::fs::read(file_path(root, name)).map_err(io_err)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("FILE_TOO_LARGE".to_owned());
    }
    let sha = sha_hex(&bytes);
    let base = base_of(root, name).unwrap_or_default();
    if base == sha {
        return Ok(CanvasTransferResult {
            status: 200,
            sha256: Some(sha),
            body: None,
        });
    }
    let path = scoped_path(name);
    let url = api_url(base_url, "/file", &[("path", &path), ("baseSha", &base)])?;
    let response = client
        .put(url)
        .bearer_auth(token)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/octet-stream")
        .timeout(TRANSFER_TIMEOUT)
        .body(bytes)
        .send()
        .await
        .map_err(describe_error)?;
    let status = response.status().as_u16();
    let body = read_json(response).await?;
    if status != 200 {
        return Ok(CanvasTransferResult {
            status,
            sha256: None,
            body,
        });
    }
    let server_sha = body
        .as_ref()
        .and_then(|value| value.get("sha256"))
        .and_then(Value::as_str)
        .unwrap_or(&sha)
        .to_owned();
    set_base(root, name, &server_sha)?;
    Ok(CanvasTransferResult {
        status,
        sha256: Some(server_sha),
        body,
    })
}

// ---------------------------------------------------------------- wait 长轮询（可取消）

fn registry() -> MutexGuard<'static, HashMap<String, CancellationToken>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    REGISTRY
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn register(request_id: &str) -> CancellationToken {
    registry()
        .entry(request_id.to_owned())
        .or_insert_with(CancellationToken::new)
        .clone()
}

pub(super) fn unregister(request_id: &str) {
    registry().remove(request_id);
}

pub(super) fn cancel_request(request_id: &str) {
    let mut map = registry();
    if !map.contains_key(request_id) && map.len() >= MAX_TOMBSTONES {
        map.retain(|_, token| !token.is_cancelled());
    }
    map.entry(request_id.to_owned())
        .or_insert_with(CancellationToken::new)
        .cancel();
}

async fn wait_once(
    client: &Client,
    url: Url,
    token: &str,
    timeout_ms: u64,
    cancel: &CancellationToken,
) -> Result<CanvasHttpResponse, String> {
    let request = client
        .get(url)
        .bearer_auth(token)
        .header(ACCEPT, "application/json")
        .timeout(Duration::from_millis(timeout_ms) + WAIT_GRACE);
    let exchange = async move {
        let response = request.send().await.map_err(describe_error)?;
        let status = response.status().as_u16();
        Ok(CanvasHttpResponse {
            status,
            body: read_json(response).await?,
        })
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("CANCELLED".to_owned()),
        result = exchange => result,
    }
}

// ---------------------------------------------------------------- tauri 命令

pub(super) fn mirror_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::vcp_modules::infra::file_manager::get_support_root_dir(app)?.join(MIRROR_DIR))
}

/// GET /manifest → `{revision, files:[{path,size,mtime,sha256}]}`，原样交回。
#[tauri::command]
pub async fn canvas_manifest(
    base_url: String,
    token: String,
) -> Result<CanvasHttpResponse, String> {
    let token = require_token(&token)?;
    let url = api_url(&base_url, "/manifest", &[])?;
    json_exchange(canvas_client()?, Method::GET, url, token, None).await
}

/// 拉取 `canvas/<name>` 到本机镜像；`sha256` 为 manifest 中的值，用于本机已一致时免下载。
#[tauri::command]
pub async fn canvas_pull(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    name: String,
    sha256: Option<String>,
) -> Result<CanvasTransferResult, String> {
    let token = require_token(&token)?;
    let root = mirror_root(&app)?;
    pull(
        canvas_client()?,
        &root,
        &base_url,
        token,
        &name,
        sha256.as_deref(),
    )
    .await
}

/// 以记录的 baseSha 上推本机 `canvas/<name>`；409 时 body 带 `serverSha`。
#[tauri::command]
pub async fn canvas_push(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    name: String,
) -> Result<CanvasTransferResult, String> {
    let token = require_token(&token)?;
    let root = mirror_root(&app)?;
    push(canvas_client()?, &root, &base_url, token, &name).await
}

/// GET /wait 长轮询，`since` 为上次的 revision 字符串；`request_id` 供 [`canvas_wait_cancel`] 中止。
#[tauri::command]
pub async fn canvas_wait(
    request_id: String,
    base_url: String,
    token: String,
    since: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<CanvasHttpResponse, String> {
    let timeout_ms = timeout_ms
        .unwrap_or(DEFAULT_WAIT_MS)
        .clamp(MIN_WAIT_MS, MAX_WAIT_MS);
    let token = require_token(&token)?;
    let timeout_text = timeout_ms.to_string();
    let since = since.unwrap_or_default();
    let url = api_url(
        &base_url,
        "/wait",
        &[("since", &since), ("timeoutMs", &timeout_text)],
    )?;
    let client = canvas_client()?;
    let cancel = register(&request_id);
    let result = if cancel.is_cancelled() {
        Err("CANCELLED".to_owned())
    } else {
        wait_once(client, url, token, timeout_ms, &cancel).await
    };
    unregister(&request_id);
    result
}

/// 中止在途的 [`canvas_wait`]；先于 wait 到达时留下取消标记。
#[tauri::command]
pub async fn canvas_wait_cancel(request_id: String) {
    cancel_request(&request_id);
}

/// GET /bindings → `{revision, bindings:{<归一键>:{agentId,topicId,itemType,updatedAt,source}}}`。
#[tauri::command]
pub async fn canvas_bindings_get(
    base_url: String,
    token: String,
) -> Result<CanvasHttpResponse, String> {
    let token = require_token(&token)?;
    let url = api_url(&base_url, "/bindings", &[])?;
    json_exchange(canvas_client()?, Method::GET, url, token, None).await
}

/// PUT /bindings?path=canvas/<name>，电脑端记为 source:'manual'。
#[tauri::command]
pub async fn canvas_bindings_put(
    base_url: String,
    token: String,
    name: String,
    agent_id: String,
    topic_id: String,
    item_type: Option<String>,
) -> Result<CanvasHttpResponse, String> {
    let token = require_token(&token)?;
    validate_name(&name)?;
    if agent_id.trim().is_empty() || topic_id.trim().is_empty() {
        return Err("INVALID_BINDING".to_owned());
    }
    let path = scoped_path(&name);
    let url = api_url(&base_url, "/bindings", &[("path", &path)])?;
    let body = serde_json::to_vec(&json!({
        "agentId": agent_id,
        "topicId": topic_id,
        "itemType": item_type,
    }))
    .map_err(|e| format!("INVALID_BODY: {e}"))?;
    json_exchange(canvas_client()?, Method::PUT, url, token, Some(body)).await
}

#[tauri::command]
pub async fn canvas_local_list(app: tauri::AppHandle) -> Result<Vec<CanvasLocalEntry>, String> {
    list_local(&mirror_root(&app)?)
}

#[tauri::command]
pub async fn canvas_local_read(app: tauri::AppHandle, name: String) -> Result<String, String> {
    read_local(&mirror_root(&app)?, &name)
}

#[tauri::command]
pub async fn canvas_local_write(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<String, String> {
    write_local(&mirror_root(&app)?, &name, &content)
}

#[tauri::command]
pub async fn canvas_local_save_conflict(
    app: tauri::AppHandle,
    name: String,
) -> Result<String, String> {
    save_conflict(&mirror_root(&app)?, &name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinHandle;

    const UNUSED_BASE: &str = "http://127.0.0.1:9";

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

    fn reply(status: &str, content_type: &str, body: &[u8]) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        )
    }

    #[test]
    fn names_follow_desktop_scope_rules() {
        for ok in ["笔记.md", "a.TXT", "draft v2.md"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", ".", "..", "a/b.md", "a\\b.md", "c:x.md", "x.md ", "x.md.", "x.png",
        ] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
        assert!(is_local_only("x.conflict-手机-1.md"));
        assert!(is_local_only("x.bak.md"));
        assert!(!is_local_only("x.md"));
    }

    #[test]
    fn url_trims_base_and_encodes_scoped_path() {
        let url = api_url(
            " http://h:5974/ ",
            "/file",
            &[("path", "canvas/笔记 1.md"), ("baseSha", "")],
        )
        .unwrap();
        assert_eq!(url.path(), "/api/canvas-sync/file");
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(
            pairs,
            vec![
                ("path".to_owned(), "canvas/笔记 1.md".to_owned()),
                ("baseSha".to_owned(), String::new()),
            ]
        );
        assert_eq!(
            api_url("http://h", "/manifest", &[]).unwrap().as_str(),
            "http://h/api/canvas-sync/manifest"
        );
        assert!(api_url("file:///x", "/manifest", &[]).is_err());
    }

    #[test]
    fn local_write_list_read_and_conflict_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(list_local(root).unwrap().is_empty());
        let sha = write_local(root, "a.md", "hello").unwrap();
        assert_eq!(sha, sha_hex(b"hello"));
        assert_eq!(read_local(root, "a.md").unwrap(), "hello");
        assert_eq!(read_local(root, "missing.md").unwrap_err(), "NOT_FOUND");
        let copy = save_conflict(root, "a.md").unwrap();
        assert!(
            copy.starts_with("a.conflict-手机-") && copy.ends_with(".md"),
            "{copy}"
        );
        let listed = list_local(root).unwrap();
        assert_eq!(listed.len(), 2);
        let original = listed.iter().find(|e| e.name == "a.md").unwrap();
        assert_eq!(original.sha256, sha);
        assert_eq!(original.base_sha, None);
        assert!(!original.local_only);
        assert!(listed.iter().any(|e| e.name == copy && e.local_only));
        assert_eq!(conflict_name("a.md", 7, 2), "a.conflict-手机-7-2.md");
    }

    #[tokio::test]
    async fn pull_writes_mirror_and_records_base() {
        let dir = tempfile::tempdir().unwrap();
        let (base, server) = serve_once(reply(
            "200 OK",
            "application/octet-stream",
            "正文".as_bytes(),
        ))
        .await;
        let result = pull(&test_client(), dir.path(), &base, "tok", "笔记.md", None)
            .await
            .unwrap();
        let request = server.await.unwrap();
        assert!(
            request.starts_with("GET /api/canvas-sync/file?path=canvas%2F"),
            "{request}"
        );
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer tok"));
        let sha = sha_hex("正文".as_bytes());
        assert_eq!(result.status, 200);
        assert_eq!(result.sha256.as_deref(), Some(sha.as_str()));
        assert_eq!(read_local(dir.path(), "笔记.md").unwrap(), "正文");
        assert_eq!(
            base_of(dir.path(), "笔记.md").as_deref(),
            Some(sha.as_str())
        );
    }

    #[tokio::test]
    async fn pull_skips_network_when_local_matches_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let sha = write_local(dir.path(), "a.md", "same").unwrap();
        let result = pull(
            &test_client(),
            dir.path(),
            UNUSED_BASE,
            "tok",
            "a.md",
            Some(&sha),
        )
        .await
        .unwrap();
        assert_eq!(result.sha256.as_deref(), Some(sha.as_str()));
        assert_eq!(base_of(dir.path(), "a.md").as_deref(), Some(sha.as_str()));
    }

    #[tokio::test]
    async fn pull_error_status_keeps_local_and_json() {
        let dir = tempfile::tempdir().unwrap();
        write_local(dir.path(), "a.md", "mine").unwrap();
        let (base, server) = serve_once(reply(
            "404 Not Found",
            "application/json",
            br#"{"code":"CANVAS_SYNC_NOT_FOUND"}"#,
        ))
        .await;
        let result = pull(&test_client(), dir.path(), &base, "tok", "a.md", None)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(result.status, 404);
        assert_eq!(result.body.unwrap()["code"], "CANVAS_SYNC_NOT_FOUND");
        assert_eq!(read_local(dir.path(), "a.md").unwrap(), "mine");
        assert_eq!(base_of(dir.path(), "a.md"), None);
    }

    #[tokio::test]
    async fn push_sends_octet_stream_with_base_and_records_new_base() {
        let dir = tempfile::tempdir().unwrap();
        let sha = write_local(dir.path(), "a.md", "new text").unwrap();
        let body = format!(r#"{{"sha256":"{sha}"}}"#);
        let (base, server) = serve_once(reply("200 OK", "application/json", body.as_bytes())).await;
        let result = push(&test_client(), dir.path(), &base, "tok", "a.md")
            .await
            .unwrap();
        let request = server.await.unwrap();
        let lower = request.to_ascii_lowercase();
        assert!(
            request.starts_with("PUT /api/canvas-sync/file?path=canvas%2Fa.md&baseSha= "),
            "{request}"
        );
        assert!(lower.contains("content-type: application/octet-stream"));
        assert!(lower.contains("content-length: 8"));
        assert!(request.ends_with("new text"));
        assert_eq!(result.status, 200);
        assert_eq!(base_of(dir.path(), "a.md").as_deref(), Some(sha.as_str()));
        // 已一致：不再发请求。
        let again = push(&test_client(), dir.path(), UNUSED_BASE, "tok", "a.md")
            .await
            .unwrap();
        assert_eq!(again.sha256.as_deref(), Some(sha.as_str()));
    }

    #[tokio::test]
    async fn push_conflict_keeps_base_and_returns_server_sha() {
        let dir = tempfile::tempdir().unwrap();
        let old = "a".repeat(64);
        write_local(dir.path(), "a.md", "edited").unwrap();
        set_base(dir.path(), "a.md", &old).unwrap();
        let server_sha = "b".repeat(64);
        let body = format!(r#"{{"code":"CANVAS_SYNC_CONFLICT","serverSha":"{server_sha}"}}"#);
        let (base, server) =
            serve_once(reply("409 Conflict", "application/json", body.as_bytes())).await;
        let result = push(&test_client(), dir.path(), &base, "tok", "a.md")
            .await
            .unwrap();
        let request = server.await.unwrap();
        assert!(request.contains(&format!("baseSha={old}")));
        assert_eq!(result.status, 409);
        assert_eq!(result.body.unwrap()["serverSha"], server_sha.as_str());
        assert_eq!(base_of(dir.path(), "a.md").as_deref(), Some(old.as_str()));
    }

    #[tokio::test]
    async fn push_refuses_local_only_copies() {
        let dir = tempfile::tempdir().unwrap();
        write_local(dir.path(), "a.conflict-手机-1.md", "x").unwrap();
        let error = push(
            &test_client(),
            dir.path(),
            UNUSED_BASE,
            "tok",
            "a.conflict-手机-1.md",
        )
        .await
        .unwrap_err();
        assert_eq!(error, "LOCAL_ONLY");
    }

    #[tokio::test]
    async fn bindings_put_sends_scoped_path_and_json_body() {
        let (base, server) = serve_once(reply(
            "200 OK",
            "application/json",
            br#"{"revision":"r","key":"a.md"}"#,
        ))
        .await;
        let response = canvas_bindings_put(
            base,
            "tok".to_owned(),
            "A.md".to_owned(),
            "agent1".to_owned(),
            "topic1".to_owned(),
            Some("agent".to_owned()),
        )
        .await
        .unwrap();
        let request = server.await.unwrap();
        assert!(
            request.starts_with("PUT /api/canvas-sync/bindings?path=canvas%2FA.md "),
            "{request}"
        );
        assert!(request.contains(r#""agentId":"agent1""#));
        assert!(request.contains(r#""itemType":"agent""#));
        assert_eq!(response.status, 200);
    }

    #[tokio::test]
    async fn wait_cancel_before_request_returns_immediately() {
        cancel_request("canvas-test-early");
        let result = canvas_wait(
            "canvas-test-early".to_owned(),
            UNUSED_BASE.to_owned(),
            "tok".to_owned(),
            Some("1-1".to_owned()),
            Some(5_000),
        )
        .await;
        assert_eq!(result.unwrap_err(), "CANCELLED");
        assert!(!registry().contains_key("canvas-test-early"));
    }

    #[tokio::test]
    async fn wait_cancel_aborts_hanging_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let hold = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(socket);
        });
        let waiting = tokio::spawn(canvas_wait(
            "canvas-test-hang".to_owned(),
            base,
            "tok".to_owned(),
            None,
            Some(30_000),
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        canvas_wait_cancel("canvas-test-hang".to_owned()).await;
        let result = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("cancel should end wait")
            .unwrap();
        assert_eq!(result.unwrap_err(), "CANCELLED");
        hold.abort();
    }

    #[tokio::test]
    async fn blank_token_is_rejected_before_network() {
        assert_eq!(
            canvas_manifest(UNUSED_BASE.to_owned(), "  ".to_owned())
                .await
                .unwrap_err(),
            "TOKEN_MISSING"
        );
    }
}
