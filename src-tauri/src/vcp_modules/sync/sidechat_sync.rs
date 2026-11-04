//! 子话题文件通道客户端（ptp4g#41）：电脑端 VCPSidechatSync（`/api/sidechat-sync`）。
//!
//! 子话题目录 `UserData/<owner>/topics/sidechat_*` 不进 CDS，聊天同步协议传不过来，这里单走文件通道。
//! 第一期只拉不推不删：前端取 manifest 后逐个调用 pull，按 sha 增量写入
//! `<support_root>/sidechat-mirror/<path>`；`sidechat-mirror/state.json` 记每个文件最后拉到的 sha。
//! 路径口径与电脑端 `parseScopedPath` 一致；网络 helper 复用 [`super::canvas_sync`]。

use super::canvas_sync::{atomic_write, canvas_client, describe_error, io_err, read_limited};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API_PREFIX: &str = "/api/sidechat-sync";
const MIRROR_DIR: &str = "sidechat-mirror";
const STATE_FILE: &str = "state.json";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
/// 与电脑端 MAX_FILE_BYTES 一致。
const MAX_FILE_BYTES: usize = 200 * 1024 * 1024;
/// UserData/<owner>/topics/<sidechat_id>/<file...>
const MIN_SEGMENTS: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidechatHttpResponse {
    pub status: u16,
    pub body: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidechatPullResult {
    pub status: u16,
    pub sha256: Option<String>,
    /// 本机已与 manifest 一致，未走网络。
    pub skipped: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidechatLocalEntry {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct MirrorState {
    #[serde(default)]
    base: BTreeMap<String, String>,
}

// ---------------------------------------------------------------- 路径

/// 与电脑端 isExcludedName 同口径：原子写临时文件、备份、冲突副本、隐藏文件。
fn is_excluded(name: &str) -> bool {
    name.starts_with('.')
        || name.ends_with(".tmp")
        || name.contains(".bak")
        || name.contains(".conflict-")
}

/// `^sidechat_\d+_[0-9a-f]+$`
fn is_child_id(segment: &str) -> bool {
    let Some(rest) = segment.strip_prefix("sidechat_") else {
        return false;
    };
    let Some((ms, hex)) = rest.split_once('_') else {
        return false;
    };
    !ms.is_empty()
        && ms.bytes().all(|b| b.is_ascii_digit())
        && !hex.is_empty()
        && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(super) fn validate_path(path: &str) -> Result<Vec<&str>, String> {
    let segments: Vec<&str> = path.split('/').collect();
    let bad_segment =
        |s: &&str| s.is_empty() || *s == "." || *s == ".." || s.contains(['\\', ':', '\0']);
    let invalid = segments.len() < MIN_SEGMENTS
        || segments.iter().any(bad_segment)
        || segments[0] != "UserData"
        || segments[2] != "topics"
        || !is_child_id(segments[3])
        || segments[1..].iter().any(|s| is_excluded(s));
    if invalid {
        return Err("INVALID_PATH".to_owned());
    }
    Ok(segments)
}

fn local_path(root: &Path, segments: &[&str]) -> PathBuf {
    segments
        .iter()
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
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

// ---------------------------------------------------------------- 本地镜像

fn sha_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn state_guard() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn load_state(root: &Path) -> MirrorState {
    std::fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn base_of(root: &Path, path: &str) -> Option<String> {
    let _guard = state_guard();
    load_state(root).base.get(path).cloned()
}

fn set_base(root: &Path, path: &str, sha: &str) -> Result<(), String> {
    let _guard = state_guard();
    let mut state = load_state(root);
    state.base.insert(path.to_owned(), sha.to_owned());
    let bytes = serde_json::to_vec(&state).map_err(|e| format!("STATE_ENCODE: {e}"))?;
    atomic_write(&root.join(STATE_FILE), &bytes)
}

/// 本机正文已等于 manifest 的 sha 时只记 base，不走网络。
fn already_current(
    root: &Path,
    path: &str,
    segments: &[&str],
    expected: &str,
) -> Result<bool, String> {
    match std::fs::read(local_path(root, segments)) {
        Ok(bytes) if sha_hex(&bytes) == expected => {
            set_base(root, path, expected)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

async fn pull(
    client: &Client,
    root: &Path,
    base_url: &str,
    token: &str,
    path: &str,
    expected: Option<&str>,
) -> Result<SidechatPullResult, String> {
    let segments = validate_path(path)?;
    if let Some(expected) = expected {
        if already_current(root, path, &segments, expected)? {
            return Ok(SidechatPullResult {
                status: 200,
                sha256: Some(expected.to_owned()),
                skipped: true,
            });
        }
    }
    let url = api_url(base_url, "/file", &[("path", path)])?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .timeout(TRANSFER_TIMEOUT)
        .send()
        .await
        .map_err(describe_error)?;
    let status = response.status().as_u16();
    if status != 200 {
        return Ok(SidechatPullResult {
            status,
            sha256: None,
            skipped: false,
        });
    }
    let bytes = read_limited(response, MAX_FILE_BYTES)
        .await?
        .ok_or_else(|| "FILE_TOO_LARGE".to_owned())?;
    let sha = sha_hex(&bytes);
    atomic_write(&local_path(root, &segments), &bytes)?;
    set_base(root, path, &sha)?;
    Ok(SidechatPullResult {
        status,
        sha256: Some(sha),
        skipped: false,
    })
}

fn list_local(root: &Path) -> Result<Vec<SidechatLocalEntry>, String> {
    let mut out = Vec::new();
    let start = root.join("UserData");
    if !start.is_dir() {
        return Ok(out);
    }
    let mut stack = vec![start];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let file_type = entry.file_type().map_err(io_err)?;
            let full = entry.path();
            if file_type.is_dir() {
                stack.push(full);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Ok(relative) = full.strip_prefix(root) else {
                continue;
            };
            let rel = relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if validate_path(&rel).is_err() {
                continue;
            }
            let size = entry.metadata().map_err(io_err)?.len();
            out.push(SidechatLocalEntry { path: rel, size });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// 电脑端已删的子话题文件：删本机镜像与 base，再自下而上删空目录（停在 `UserData/<owner>/topics`）。
fn remove_local(root: &Path, path: &str) -> Result<bool, String> {
    let segments = validate_path(path)?;
    let target = local_path(root, &segments);
    let removed = match std::fs::remove_file(&target) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(io_err(error)),
    };
    {
        let _guard = state_guard();
        let mut state = load_state(root);
        if state.base.remove(path).is_some() {
            let bytes = serde_json::to_vec(&state).map_err(|e| format!("STATE_ENCODE: {e}"))?;
            atomic_write(&root.join(STATE_FILE), &bytes)?;
        }
    }
    let stop = local_path(root, &segments[..3]);
    let mut dir = target.parent().map(Path::to_path_buf);
    while let Some(current) = dir {
        if current == stop || !current.starts_with(&stop) {
            break;
        }
        if std::fs::remove_dir(&current).is_err() {
            break;
        }
        dir = current.parent().map(Path::to_path_buf);
    }
    Ok(removed)
}

// ---------------------------------------------------------------- 双向（ptp4g#46）

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidechatTransferResult {
    pub status: u16,
    /// push 成功时为现在的 baseSha。
    pub sha256: Option<String>,
    /// 409 时带 `serverSha`。
    pub body: Option<Value>,
}

/// 三方比对的本机一侧：`sha256` 为 None 表示本机已删、只剩基线。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidechatLocalStatus {
    pub path: String,
    pub sha256: Option<String>,
    pub base_sha: Option<String>,
}

async fn read_json(response: reqwest::Response) -> Result<Option<Value>, String> {
    Ok(read_limited(response, MAX_JSON_BYTES)
        .await?
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()))
}

fn forget_base(root: &Path, path: &str) -> Result<(), String> {
    let _guard = state_guard();
    let mut state = load_state(root);
    if state.base.remove(path).is_some() {
        let bytes = serde_json::to_vec(&state).map_err(|e| format!("STATE_ENCODE: {e}"))?;
        atomic_write(&root.join(STATE_FILE), &bytes)?;
    }
    Ok(())
}

/// 本机现有文件的 sha 与基线，加上"记过基线、本机已删"的条目。
fn local_status(root: &Path) -> Result<Vec<SidechatLocalStatus>, String> {
    let base = {
        let _guard = state_guard();
        load_state(root).base
    };
    let mut out = Vec::new();
    for entry in list_local(root)? {
        let segments = validate_path(&entry.path)?;
        let bytes = match std::fs::read(local_path(root, &segments)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io_err(error)),
        };
        out.push(SidechatLocalStatus {
            base_sha: base.get(&entry.path).cloned(),
            sha256: Some(sha_hex(&bytes)),
            path: entry.path,
        });
    }
    for (path, sha) in &base {
        if validate_path(path).is_ok() && !out.iter().any(|s| &s.path == path) {
            out.push(SidechatLocalStatus {
                path: path.clone(),
                sha256: None,
                base_sha: Some(sha.clone()),
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// 原子写本机子话题文件，返回新 sha；不动基线（是否上推由同步决定）。
fn write_local(root: &Path, path: &str, content: &[u8]) -> Result<String, String> {
    let segments = validate_path(path)?;
    if content.len() > MAX_FILE_BYTES {
        return Err("FILE_TOO_LARGE".to_owned());
    }
    atomic_write(&local_path(root, &segments), content)?;
    Ok(sha_hex(content))
}

/// 本机版本另存为 `<stem>.conflict-手机<ext>`（重名再加毫秒）；同步口径排除该名，不会被推走。
fn save_conflict(root: &Path, path: &str) -> Result<String, String> {
    let segments = validate_path(path)?;
    let source = local_path(root, &segments);
    let name = segments[segments.len() - 1];
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let dir = source.parent().ok_or_else(|| "INVALID_PATH".to_owned())?;
    let mut target = dir.join(format!("{stem}.conflict-手机{ext}"));
    if target.exists() {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        target = dir.join(format!("{stem}.conflict-手机-{ms}{ext}"));
    }
    let bytes = std::fs::read(&source).map_err(io_err)?;
    atomic_write(&target, &bytes)?;
    Ok(target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default())
}

/// 以基线做乐观并发 PUT；200 记新基线，409 不动基线并交回 body（含 serverSha）。
async fn push(
    client: &Client,
    root: &Path,
    base_url: &str,
    token: &str,
    path: &str,
) -> Result<SidechatTransferResult, String> {
    let segments = validate_path(path)?;
    let bytes = std::fs::read(local_path(root, &segments)).map_err(io_err)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("FILE_TOO_LARGE".to_owned());
    }
    let sha = sha_hex(&bytes);
    let base = base_of(root, path).unwrap_or_default();
    if base == sha {
        return Ok(SidechatTransferResult {
            status: 200,
            sha256: Some(sha),
            body: None,
        });
    }
    let url = api_url(base_url, "/file", &[("path", path), ("baseSha", &base)])?;
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
        return Ok(SidechatTransferResult {
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
    set_base(root, path, &server_sha)?;
    Ok(SidechatTransferResult {
        status,
        sha256: Some(server_sha),
        body,
    })
}

/// 本机已删：以基线请电脑端物理删除。200 与 409 都清基线
/// （409 serverSha 为空即电脑端也已删；带 sha 表示电脑端改过，下一轮拉回）。
async fn delete_remote(
    client: &Client,
    root: &Path,
    base_url: &str,
    token: &str,
    path: &str,
) -> Result<SidechatTransferResult, String> {
    validate_path(path)?;
    let Some(base) = base_of(root, path) else {
        return Err("NO_BASE".to_owned());
    };
    let url = api_url(base_url, "/file", &[("path", path), ("baseSha", &base)])?;
    let response = client
        .delete(url)
        .bearer_auth(token)
        .header(ACCEPT, "application/json")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(describe_error)?;
    let status = response.status().as_u16();
    let body = read_json(response).await?;
    if status == 200 || status == 409 {
        forget_base(root, path)?;
    }
    Ok(SidechatTransferResult {
        status,
        sha256: None,
        body,
    })
}

fn mirror_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::vcp_modules::infra::file_manager::get_support_root_dir(app)?.join(MIRROR_DIR))
}

// ---------------------------------------------------------------- commands

/// GET /manifest → `{revision, files:[{path,size,mtime,sha256}]}`，原样交回。
#[tauri::command]
pub async fn sidechat_manifest(
    base_url: String,
    token: String,
) -> Result<SidechatHttpResponse, String> {
    let token = require_token(&token)?;
    let url = api_url(&base_url, "/manifest", &[])?;
    let response = canvas_client()?
        .get(url)
        .bearer_auth(token)
        .header(ACCEPT, "application/json")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(describe_error)?;
    let status = response.status().as_u16();
    let body = read_limited(response, MAX_JSON_BYTES)
        .await?
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    Ok(SidechatHttpResponse { status, body })
}

/// 拉取一个子话题文件到本机镜像；`sha256` 为 manifest 中的值，本机已一致时免下载。
#[tauri::command]
pub async fn sidechat_pull(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    path: String,
    sha256: Option<String>,
) -> Result<SidechatPullResult, String> {
    let token = require_token(&token)?;
    let root = mirror_root(&app)?;
    pull(
        canvas_client()?,
        &root,
        &base_url,
        token,
        &path,
        sha256.as_deref(),
    )
    .await
}

/// 列出本机镜像中的子话题文件（相对路径 + 大小）。
#[tauri::command]
pub async fn sidechat_local_list(app: tauri::AppHandle) -> Result<Vec<SidechatLocalEntry>, String> {
    list_local(&mirror_root(&app)?)
}

/// 读取本机镜像中的一个子话题文件（UTF-8 文本）。
#[tauri::command]
pub async fn sidechat_local_read(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let root = mirror_root(&app)?;
    let segments = validate_path(&path)?;
    let bytes = std::fs::read(local_path(&root, &segments)).map_err(io_err)?;
    String::from_utf8(bytes).map_err(|_| "NOT_UTF8".to_owned())
}

/// 删除本机镜像中电脑端已不存在的子话题文件（连带清空空目录）。
#[tauri::command]
pub async fn sidechat_local_remove(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    remove_local(&mirror_root(&app)?, &path)
}

/// 以记录的基线上推一个子话题文件；409 时 body 带 `serverSha`。
#[tauri::command]
pub async fn sidechat_push(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    path: String,
) -> Result<SidechatTransferResult, String> {
    let token = require_token(&token)?;
    let root = mirror_root(&app)?;
    push(canvas_client()?, &root, &base_url, token, &path).await
}

/// 本机已删的子话题文件：请电脑端删除。
#[tauri::command]
pub async fn sidechat_delete(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    path: String,
) -> Result<SidechatTransferResult, String> {
    let token = require_token(&token)?;
    let root = mirror_root(&app)?;
    delete_remote(canvas_client()?, &root, &base_url, token, &path).await
}

/// 三方比对用的本机状态（含只剩基线的已删条目）。
#[tauri::command]
pub async fn sidechat_local_status(
    app: tauri::AppHandle,
) -> Result<Vec<SidechatLocalStatus>, String> {
    local_status(&mirror_root(&app)?)
}

/// 原子写本机子话题文件（UTF-8 文本），返回新 sha。
#[tauri::command]
pub async fn sidechat_local_write(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<String, String> {
    write_local(&mirror_root(&app)?, &path, content.as_bytes())
}

/// 清基线：电脑端已删、本机又改过时，让本机版本按新建上推。
#[tauri::command]
pub async fn sidechat_forget_base(app: tauri::AppHandle, path: String) -> Result<(), String> {
    validate_path(&path)?;
    forget_base(&mirror_root(&app)?, &path)
}

/// 本机版本另存冲突副本，返回副本文件名。
#[tauri::command]
pub async fn sidechat_save_conflict(app: tauri::AppHandle, path: String) -> Result<String, String> {
    save_conflict(&mirror_root(&app)?, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinHandle;

    const P: &str = "UserData/o/topics/sidechat_1_ab/history.json";

    fn test_client() -> Client {
        Client::builder().no_proxy().build().unwrap()
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
            if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
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
        let base = format!("http://{}", listener.local_addr().unwrap());
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
        (base, handle)
    }

    #[tokio::test]
    async fn push_new_file_sends_empty_base_and_records_sha() {
        let dir = tempfile::tempdir().unwrap();
        let sha = write_local(dir.path(), P, b"[1]").unwrap();
        let (base, server) = serve_once("200 OK", &format!(r#"{{"sha256":"{sha}"}}"#)).await;
        let result = push(&test_client(), dir.path(), &base, "tok", P)
            .await
            .unwrap();
        let request = server.await.unwrap();
        assert!(request.starts_with("PUT /api/sidechat-sync/file?path=UserData%2Fo%2Ftopics%2Fsidechat_1_ab%2Fhistory.json&baseSha= "), "{request}");
        assert!(request
            .to_ascii_lowercase()
            .contains("content-type: application/octet-stream"));
        assert!(request.ends_with("[1]"));
        assert_eq!(result.status, 200);
        assert_eq!(base_of(dir.path(), P).as_deref(), Some(sha.as_str()));
        // 已一致：不发请求。
        let again = push(&test_client(), dir.path(), "http://127.0.0.1:9", "tok", P)
            .await
            .unwrap();
        assert_eq!(again.sha256.as_deref(), Some(sha.as_str()));
    }

    #[tokio::test]
    async fn push_conflict_keeps_base_and_returns_server_sha() {
        let dir = tempfile::tempdir().unwrap();
        let old = "a".repeat(64);
        write_local(dir.path(), P, b"mine").unwrap();
        set_base(dir.path(), P, &old).unwrap();
        let server_sha = "b".repeat(64);
        let (base, server) = serve_once(
            "409 Conflict",
            &format!(r#"{{"code":"SIDECHAT_SYNC_CONFLICT","serverSha":"{server_sha}"}}"#),
        )
        .await;
        let result = push(&test_client(), dir.path(), &base, "tok", P)
            .await
            .unwrap();
        assert!(server.await.unwrap().contains(&format!("baseSha={old}")));
        assert_eq!(result.status, 409);
        assert_eq!(result.body.unwrap()["serverSha"], server_sha.as_str());
        assert_eq!(base_of(dir.path(), P).as_deref(), Some(old.as_str()));
    }

    #[tokio::test]
    async fn delete_sends_base_and_forgets_it() {
        let dir = tempfile::tempdir().unwrap();
        let old = "c".repeat(64);
        set_base(dir.path(), P, &old).unwrap();
        let (base, server) = serve_once("200 OK", r#"{"deleted":true}"#).await;
        let result = delete_remote(&test_client(), dir.path(), &base, "tok", P)
            .await
            .unwrap();
        let request = server.await.unwrap();
        assert!(
            request.starts_with("DELETE /api/sidechat-sync/file?"),
            "{request}"
        );
        assert!(request.contains(&format!("baseSha={old}")));
        assert_eq!(result.status, 200);
        assert_eq!(base_of(dir.path(), P), None);
        let error = delete_remote(&test_client(), dir.path(), "http://127.0.0.1:9", "tok", P)
            .await
            .unwrap_err();
        assert_eq!(error, "NO_BASE");
    }

    #[test]
    fn status_lists_local_and_deleted_and_conflict_copy_is_excluded() {
        let dir = tempfile::tempdir().unwrap();
        let sha = write_local(dir.path(), P, b"[]").unwrap();
        set_base(dir.path(), P, &sha).unwrap();
        let gone = "UserData/o/topics/sidechat_1_ab/sidechat-child.json";
        set_base(dir.path(), gone, &"d".repeat(64)).unwrap();

        let copy = save_conflict(dir.path(), P).unwrap();
        assert_eq!(copy, "history.conflict-手机.json");
        let second = save_conflict(dir.path(), P).unwrap();
        assert!(second.starts_with("history.conflict-手机-") && second.ends_with(".json"));

        let status = local_status(dir.path()).unwrap();
        assert_eq!(status.len(), 2, "{status:?}");
        assert_eq!(status[0].path, P);
        assert_eq!(status[0].sha256.as_deref(), Some(sha.as_str()));
        assert_eq!(status[0].base_sha.as_deref(), Some(sha.as_str()));
        assert_eq!(status[1].path, gone);
        assert_eq!(status[1].sha256, None);

        forget_base(dir.path(), gone).unwrap();
        assert_eq!(local_status(dir.path()).unwrap().len(), 1);
        assert!(write_local(dir.path(), "UserData/o/topics/topic_1/history.json", b"x").is_err());
    }

    #[test]
    fn accepts_files_under_child_dir() {
        for path in [
            "UserData/_Agent_1/topics/sidechat_1793532536608_df7b17/history.json",
            "UserData/_Agent_1/topics/sidechat_1_ab/attachments/a.png",
        ] {
            assert!(validate_path(path).is_ok(), "{path}");
        }
    }

    #[test]
    fn rejects_out_of_scope_paths() {
        for path in [
            "UserData/a/topics/topic_1/history.json",
            "UserData/a/topics/sidechat_1_xyz/history.json",
            "UserData/a/topics/sidechat_1_ab",
            "Agents/a/topics/sidechat_1_ab/x.json",
            "UserData/a/topics/sidechat_1_ab/../x.json",
            "UserData/a/topics/sidechat_1_ab/h.json.bak",
            "UserData/a/topics/sidechat_1_ab/.x.tmp",
            "UserData/a/topics/sidechat_1_ab/c:x",
            "/UserData/a/topics/sidechat_1_ab/h.json",
            "UserData/a\\b/topics/sidechat_1_ab/h.json",
        ] {
            assert!(validate_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn skips_download_when_local_matches_and_lists_mirror() {
        let root = std::env::temp_dir().join(format!("sidechat-sync-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let path = "UserData/o/topics/sidechat_1_ab/history.json";
        let segments = validate_path(path).unwrap();
        atomic_write(&local_path(&root, &segments), b"[]").unwrap();
        let sha = sha_hex(b"[]");

        assert!(already_current(&root, path, &segments, &sha).unwrap());
        assert!(!already_current(&root, path, &segments, &"0".repeat(64)).unwrap());
        assert_eq!(base_of(&root, path).as_deref(), Some(sha.as_str()));

        let listed = list_local(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, path);
        assert_eq!(listed[0].size, 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_local_deletes_file_base_and_empty_dirs() {
        let root =
            std::env::temp_dir().join(format!("sidechat-remove-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let a = "UserData/o/topics/sidechat_1_ab/history.json";
        let b = "UserData/o/topics/sidechat_1_ab/sidechat-child.json";
        for p in [a, b] {
            let segments = validate_path(p).unwrap();
            atomic_write(&local_path(&root, &segments), b"{}").unwrap();
            set_base(&root, p, &sha_hex(b"{}")).unwrap();
        }
        assert!(remove_local(&root, a).unwrap());
        assert!(root.join("UserData/o/topics/sidechat_1_ab").is_dir());
        assert!(remove_local(&root, b).unwrap());
        assert!(!root.join("UserData/o/topics/sidechat_1_ab").exists());
        assert!(root.join("UserData/o/topics").is_dir());
        assert_eq!(base_of(&root, a), None);
        assert!(!remove_local(&root, a).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }
}
