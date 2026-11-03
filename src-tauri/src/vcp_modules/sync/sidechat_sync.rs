//! 子话题文件通道客户端（ptp4g#41）：电脑端 VCPSidechatSync（`/api/sidechat-sync`）。
//!
//! 子话题目录 `UserData/<owner>/topics/sidechat_*` 不进 CDS，聊天同步协议传不过来，这里单走文件通道。
//! 第一期只拉不推不删：前端取 manifest 后逐个调用 pull，按 sha 增量写入
//! `<support_root>/sidechat-mirror/<path>`；`sidechat-mirror/state.json` 记每个文件最后拉到的 sha。
//! 路径口径与电脑端 `parseScopedPath` 一致；网络 helper 复用 [`super::canvas_sync`]。

use super::canvas_sync::{atomic_write, canvas_client, describe_error, io_err, read_limited};
use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
