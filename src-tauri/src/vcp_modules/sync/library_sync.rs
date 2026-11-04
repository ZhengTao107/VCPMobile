//! 提示词仓库、系统提示词预设与模型收藏的手机侧通道（ptp4g#47）。
//!
//! 电脑端 VCPCanvasSync 把 AppData 根下的 `global_prompt_warehouse.json`、`model_favorites.json`
//! 与 `systemPromptPresets/` 一并列进 `/api/canvas-sync/manifest`，读写同 canvas 的 `/file`
//! （GET 原始字节；PUT octet-stream + baseSha，不一致 409 `{serverSha}`）。
//! 这里只放行这三类路径，镜像在 `<support_root>/library-mirror/`，`state.json` 记每个路径最后一次
//! 与电脑端一致时的 sha256。预设只取 `systemPromptPresets/` 根下的 .md/.txt，与电脑端
//! load-preset-prompts 的读取范围一致。拉推时机、以电脑端为准的取舍与收藏落库在
//! `src/core/sync/libraryRemote.ts`；HTTP 客户端、体积读取与原子写沿用 [`super::canvas_sync`]。

use super::canvas_sync::{
    atomic_write, canvas_client, describe_error, io_err, read_limited, validate_name,
};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

const FILE_ROUTE: &str = "/api/canvas-sync/file";
const MIRROR_DIR: &str = "library-mirror";
const STATE_FILE: &str = "state.json";
const PRESETS_DIR: &str = "systemPromptPresets";
const ROOT_FILES: [&str; 2] = ["global_prompt_warehouse.json", "model_favorites.json"];
/// 单个文件建连到读完的总时限。
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(60);
/// 错误响应体（JSON）的读取上限。
const MAX_JSON_BYTES: usize = 64 * 1024;
/// 文件正文上限：三类都是文本，远小于此值。
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTransferResult {
    pub status: u16,
    pub sha256: Option<String>,
    /// 非 200 时的 JSON 响应体（409 带 `serverSha`）。
    pub body: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLocalEntry {
    pub path: String,
    pub sha256: String,
    pub base_sha: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct MirrorState {
    #[serde(default)]
    base: BTreeMap<String, String>,
}

/// 只放行三类路径；预设名沿用 canvas 的命名规则（.md/.txt、无分隔符、无末尾点或空格）。
fn validate_path(path: &str) -> Result<(), String> {
    if ROOT_FILES.contains(&path) {
        return Ok(());
    }
    let invalid = || "INVALID_PATH".to_owned();
    let name = path
        .strip_prefix(PRESETS_DIR)
        .and_then(|rest| rest.strip_prefix('/'))
        .ok_or_else(invalid)?;
    validate_name(name).map_err(|_| invalid())?;
    if name.starts_with('.') || name.contains(".bak") || name.contains(".conflict-") {
        return Err(invalid());
    }
    Ok(())
}

fn local_path(root: &Path, path: &str) -> PathBuf {
    path.split('/')
        .fold(root.to_path_buf(), |acc, part| acc.join(part))
}

fn sha_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn require_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.is_empty() {
        Err("TOKEN_MISSING".to_owned())
    } else {
        Ok(token)
    }
}

fn file_url(base_url: &str, query: &[(&str, &str)]) -> Result<Url, String> {
    let base = base_url.trim().trim_end_matches('/');
    let mut url =
        Url::parse(&format!("{base}{FILE_ROUTE}")).map_err(|e| format!("INVALID_URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("INVALID_URL: unsupported scheme {}", url.scheme()));
    }
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    Ok(url)
}

async fn read_json(response: reqwest::Response) -> Result<Option<Value>, String> {
    Ok(read_limited(response, MAX_JSON_BYTES)
        .await?
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()))
}

// ---------------------------------------------------------------- 本地镜像

/// state.json 的读改写串行化；只包住同步 IO，不跨 await。
fn state_guard() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 缺失或损坏时视为空：下次同步按"无基线"处理，由电脑端优先的规则兜底。
fn load_state(root: &Path) -> MirrorState {
    std::fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_state(root: &Path, state: &MirrorState) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|e| format!("STATE_ENCODE: {e}"))?;
    atomic_write(&root.join(STATE_FILE), &bytes)
}

fn base_of(root: &Path, path: &str) -> Option<String> {
    let _guard = state_guard();
    load_state(root).base.get(path).cloned()
}

fn set_base(root: &Path, path: &str, sha: &str) -> Result<(), String> {
    let _guard = state_guard();
    let mut state = load_state(root);
    state.base.insert(path.to_owned(), sha.to_owned());
    save_state(root, &state)
}

fn forget_base(root: &Path, path: &str) -> Result<(), String> {
    let _guard = state_guard();
    let mut state = load_state(root);
    if state.base.remove(path).is_some() {
        save_state(root, &state)?;
    }
    Ok(())
}

fn list_local(root: &Path) -> Result<Vec<LibraryLocalEntry>, String> {
    let state = {
        let _guard = state_guard();
        load_state(root)
    };
    let mut paths: Vec<String> = ROOT_FILES.iter().map(|name| (*name).to_owned()).collect();
    match std::fs::read_dir(root.join(PRESETS_DIR)) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(io_err)?;
                if !entry.file_type().map_err(io_err)?.is_file() {
                    continue;
                }
                if let Some(name) = entry.file_name().to_str() {
                    let path = format!("{PRESETS_DIR}/{name}");
                    if validate_path(&path).is_ok() {
                        paths.push(path);
                    }
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_err(error)),
    }
    let mut listed = Vec::new();
    for path in paths {
        match std::fs::read(local_path(root, &path)) {
            Ok(bytes) => listed.push(LibraryLocalEntry {
                sha256: sha_hex(&bytes),
                base_sha: state.base.get(&path).cloned(),
                path,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io_err(error)),
        }
    }
    listed.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(listed)
}

fn read_local(root: &Path, path: &str) -> Result<String, String> {
    validate_path(path)?;
    let bytes = std::fs::read(local_path(root, path)).map_err(io_err)?;
    String::from_utf8(bytes).map_err(|_| "NOT_UTF8".to_owned())
}

/// 写本机镜像（不动 baseSha），返回新正文的 sha256。
fn write_local(root: &Path, path: &str, content: &str) -> Result<String, String> {
    validate_path(path)?;
    if content.len() > MAX_FILE_BYTES {
        return Err("FILE_TOO_LARGE".to_owned());
    }
    atomic_write(&local_path(root, path), content.as_bytes())?;
    Ok(sha_hex(content.as_bytes()))
}

/// 电脑端已没有的预设：删本机镜像与基线。不向电脑端发删除。
fn remove_local(root: &Path, path: &str) -> Result<(), String> {
    validate_path(path)?;
    match std::fs::remove_file(local_path(root, path)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_err(error)),
    }
    forget_base(root, path)
}

// ---------------------------------------------------------------- 网络

/// 拉取电脑端正文覆盖本机镜像并记 baseSha；`expected` 与本机正文一致时只记 baseSha，不走网络。
async fn pull(
    client: &Client,
    root: &Path,
    base_url: &str,
    token: &str,
    path: &str,
    expected: Option<&str>,
) -> Result<LibraryTransferResult, String> {
    validate_path(path)?;
    let target = local_path(root, path);
    if let Some(expected) = expected {
        if let Ok(bytes) = std::fs::read(&target) {
            if sha_hex(&bytes) == expected {
                set_base(root, path, expected)?;
                return Ok(LibraryTransferResult {
                    status: 200,
                    sha256: Some(expected.to_owned()),
                    body: None,
                });
            }
        }
    }
    let url = file_url(base_url, &[("path", path)])?;
    let response = client
        .get(url)
        .bearer_auth(token)
        .timeout(TRANSFER_TIMEOUT)
        .send()
        .await
        .map_err(describe_error)?;
    let status = response.status().as_u16();
    if status != 200 {
        return Ok(LibraryTransferResult {
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
    set_base(root, path, &sha)?;
    Ok(LibraryTransferResult {
        status,
        sha256: Some(sha),
        body: None,
    })
}

/// 以记录的 baseSha 上推本机镜像；200 后记新 baseSha，409 不动 baseSha。
async fn push(
    client: &Client,
    root: &Path,
    base_url: &str,
    token: &str,
    path: &str,
) -> Result<LibraryTransferResult, String> {
    validate_path(path)?;
    let bytes = std::fs::read(local_path(root, path)).map_err(io_err)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("FILE_TOO_LARGE".to_owned());
    }
    let sha = sha_hex(&bytes);
    let base = base_of(root, path).unwrap_or_default();
    if base == sha {
        return Ok(LibraryTransferResult {
            status: 200,
            sha256: Some(sha),
            body: None,
        });
    }
    let url = file_url(base_url, &[("path", path), ("baseSha", &base)])?;
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
        return Ok(LibraryTransferResult {
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
    Ok(LibraryTransferResult {
        status,
        sha256: Some(server_sha),
        body,
    })
}

fn mirror_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::vcp_modules::infra::file_manager::get_support_root_dir(app)?.join(MIRROR_DIR))
}

/// 拉取三类路径之一到本机镜像；`sha256` 为 manifest 中的值，本机已一致时免下载。
#[tauri::command]
pub async fn library_pull(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    path: String,
    sha256: Option<String>,
) -> Result<LibraryTransferResult, String> {
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

/// 以记录的 baseSha 上推本机镜像；409 时 body 带 `serverSha`。
#[tauri::command]
pub async fn library_push(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    path: String,
) -> Result<LibraryTransferResult, String> {
    let token = require_token(&token)?;
    let root = mirror_root(&app)?;
    push(canvas_client()?, &root, &base_url, token, &path).await
}

#[tauri::command]
pub async fn library_local_list(app: tauri::AppHandle) -> Result<Vec<LibraryLocalEntry>, String> {
    list_local(&mirror_root(&app)?)
}

#[tauri::command]
pub async fn library_local_read(app: tauri::AppHandle, path: String) -> Result<String, String> {
    read_local(&mirror_root(&app)?, &path)
}

#[tauri::command]
pub async fn library_local_write(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<String, String> {
    write_local(&mirror_root(&app)?, &path, &content)
}

#[tauri::command]
pub async fn library_local_remove(app: tauri::AppHandle, path: String) -> Result<(), String> {
    remove_local(&mirror_root(&app)?, &path)
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
    fn paths_are_limited_to_the_three_kinds() {
        for ok in [
            "global_prompt_warehouse.json",
            "model_favorites.json",
            "systemPromptPresets/写作.md",
            "systemPromptPresets/a.TXT",
        ] {
            assert!(validate_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "settings.json",
            "canvas/a.md",
            "systemPromptPresets/",
            "systemPromptPresets/sub/a.md",
            "systemPromptPresets/a.png",
            "systemPromptPresets/.a.md",
            "systemPromptPresets/a.bak.md",
            "systemPromptPresets/a.conflict-手机-1.md",
            "../model_favorites.json",
            "/model_favorites.json",
            "systemPromptPresets\\a.md",
        ] {
            assert!(validate_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn local_write_list_read_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(list_local(root).unwrap().is_empty());
        let sha = write_local(root, "model_favorites.json", "[\"m\"]").unwrap();
        write_local(root, "systemPromptPresets/写作.md", "你好").unwrap();
        std::fs::write(root.join(PRESETS_DIR).join("skip.png"), b"x").unwrap();
        set_base(root, "model_favorites.json", &sha).unwrap();
        let listed = list_local(root).unwrap();
        let paths: Vec<&str> = listed.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["model_favorites.json", "systemPromptPresets/写作.md"]
        );
        assert_eq!(listed[0].base_sha.as_deref(), Some(sha.as_str()));
        assert_eq!(listed[1].base_sha, None);
        assert_eq!(
            read_local(root, "systemPromptPresets/写作.md").unwrap(),
            "你好"
        );
        assert_eq!(
            write_local(root, "settings.json", "{}").unwrap_err(),
            "INVALID_PATH"
        );
        remove_local(root, "model_favorites.json").unwrap();
        assert_eq!(
            read_local(root, "model_favorites.json").unwrap_err(),
            "NOT_FOUND"
        );
        assert_eq!(base_of(root, "model_favorites.json"), None);
    }

    #[tokio::test]
    async fn pull_writes_mirror_and_records_base() {
        let dir = tempfile::tempdir().unwrap();
        let (base, server) = serve_once(reply(
            "200 OK",
            "application/octet-stream",
            "预设正文".as_bytes(),
        ))
        .await;
        let path = "systemPromptPresets/写作.md";
        let result = pull(&test_client(), dir.path(), &base, "tok", path, None)
            .await
            .unwrap();
        let request = server.await.unwrap();
        assert!(
            request.starts_with("GET /api/canvas-sync/file?path=systemPromptPresets%2F"),
            "{request}"
        );
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer tok"));
        let sha = sha_hex("预设正文".as_bytes());
        assert_eq!(result.status, 200);
        assert_eq!(result.sha256.as_deref(), Some(sha.as_str()));
        assert_eq!(read_local(dir.path(), path).unwrap(), "预设正文");
        assert_eq!(base_of(dir.path(), path).as_deref(), Some(sha.as_str()));
    }

    #[tokio::test]
    async fn push_sends_octet_stream_with_base_and_records_new_base() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let old = write_local(root, "model_favorites.json", "[\"a\"]").unwrap();
        set_base(root, "model_favorites.json", &old).unwrap();
        let new = write_local(root, "model_favorites.json", "[\"a\",\"b\"]").unwrap();
        let body = format!("{{\"sha256\":\"{new}\"}}");
        let (base, server) = serve_once(reply("200 OK", "application/json", body.as_bytes())).await;
        let result = push(&test_client(), root, &base, "tok", "model_favorites.json")
            .await
            .unwrap();
        let request = server.await.unwrap();
        assert!(
            request.starts_with(&format!(
                "PUT /api/canvas-sync/file?path=model_favorites.json&baseSha={old}"
            )),
            "{request}"
        );
        assert!(request
            .to_ascii_lowercase()
            .contains("content-type: application/octet-stream"));
        assert!(request.ends_with("[\"a\",\"b\"]"), "{request}");
        assert_eq!(result.status, 200);
        assert_eq!(
            base_of(root, "model_favorites.json").as_deref(),
            Some(new.as_str())
        );
    }

    #[tokio::test]
    async fn push_conflict_keeps_base_and_returns_server_sha() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let old = write_local(root, "global_prompt_warehouse.json", "[]").unwrap();
        set_base(root, "global_prompt_warehouse.json", &old).unwrap();
        write_local(root, "global_prompt_warehouse.json", "[{}]").unwrap();
        let (base, server) = serve_once(reply(
            "409 Conflict",
            "application/json",
            br#"{"code":"CANVAS_SYNC_CONFLICT","serverSha":"ff"}"#,
        ))
        .await;
        let result = push(
            &test_client(),
            root,
            &base,
            "tok",
            "global_prompt_warehouse.json",
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(result.status, 409);
        assert_eq!(
            result.body.as_ref().and_then(|b| b.get("serverSha")),
            Some(&Value::from("ff"))
        );
        assert_eq!(
            base_of(root, "global_prompt_warehouse.json").as_deref(),
            Some(old.as_str())
        );
    }

    #[tokio::test]
    async fn rejects_paths_outside_scope_before_network() {
        let dir = tempfile::tempdir().unwrap();
        let pulled = pull(
            &test_client(),
            dir.path(),
            UNUSED_BASE,
            "tok",
            "settings.json",
            None,
        )
        .await;
        assert_eq!(pulled, Err("INVALID_PATH".to_owned()));
        let pushed = push(
            &test_client(),
            dir.path(),
            UNUSED_BASE,
            "tok",
            "canvas/a.md",
        )
        .await;
        assert_eq!(pushed, Err("INVALID_PATH".to_owned()));
        assert_eq!(require_token(" "), Err("TOKEN_MISSING".to_owned()));
    }
}
