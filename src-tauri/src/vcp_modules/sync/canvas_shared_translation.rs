//! Canvas 译文三端共用（ptp4g#40）：电脑端 `AppData/CanvasTranslations/<name>` 的手机镜像。
//!
//! 文件名 `<docKey>-<sourceHash>-<model16>[-<requested16>]-<lang16>.json`，与电脑端
//! canvasTranslationCache.cacheFileName 及 VCPCanvasSync 的 TRANSLATION_NAME_RE 一致；
//! 记录内容（v2）由前端组装，这里只校验名字、JSON 对象并原子写入 `<mirror>/CanvasTranslations/`。
//! 拉取：GET /file?path=CanvasTranslations/<name>（404 = 电脑没有）。
//! 上推：PUT 新文件（baseSha 为空）；电脑已有同名文件时 409，内容同键视为等价，前端忽略即可。

use super::canvas_sync::{
    atomic_write, canvas_client, describe_error, io_err, mirror_root, read_limited,
};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::{Client, Url};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

const API_PREFIX: &str = "/api/canvas-sync";
const DIR: &str = "CanvasTranslations";
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTranslationTransfer {
    pub status: u16,
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `^[a-f0-9]{64}-[a-f0-9]{64}(-[a-f0-9]{16}){1,3}\.json$`
pub(super) fn validate_shared_name(name: &str) -> Result<(), String> {
    let invalid = || Err("INVALID_NAME".to_owned());
    let Some(stem) = name.strip_suffix(".json") else {
        return invalid();
    };
    let parts: Vec<&str> = stem.split('-').collect();
    if !(3..=5).contains(&parts.len()) || !is_hex(parts[0], 64) || !is_hex(parts[1], 64) {
        return invalid();
    }
    if parts[2..].iter().all(|p| is_hex(p, 16)) {
        Ok(())
    } else {
        invalid()
    }
}

fn record_path(root: &Path, name: &str) -> PathBuf {
    root.join(DIR).join(name)
}

fn load(root: &Path, name: &str) -> Result<Option<String>, String> {
    validate_shared_name(name)?;
    match std::fs::read(record_path(root, name)) {
        Ok(bytes) => Ok(String::from_utf8(bytes).ok()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_err(error)),
    }
}

fn save(root: &Path, name: &str, record: &str) -> Result<(), String> {
    validate_shared_name(name)?;
    if record.len() > MAX_RECORD_BYTES {
        return Err("RECORD_TOO_LARGE".to_owned());
    }
    let value: serde_json::Value =
        serde_json::from_str(record).map_err(|_| "INVALID_RECORD".to_owned())?;
    if !value.is_object() {
        return Err("INVALID_RECORD".to_owned());
    }
    atomic_write(&record_path(root, name), record.as_bytes())
}

fn file_url(base_url: &str, query: &[(&str, &str)]) -> Result<Url, String> {
    let base = base_url.trim().trim_end_matches('/');
    let mut url =
        Url::parse(&format!("{base}{API_PREFIX}/file")).map_err(|e| format!("INVALID_URL: {e}"))?;
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

fn require_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if token.is_empty() {
        Err("TOKEN_MISSING".to_owned())
    } else {
        Ok(token)
    }
}

async fn pull(
    client: &Client,
    root: &Path,
    base_url: &str,
    token: &str,
    name: &str,
) -> Result<SharedTranslationTransfer, String> {
    validate_shared_name(name)?;
    let path = format!("{DIR}/{name}");
    let response = client
        .get(file_url(base_url, &[("path", &path)])?)
        .bearer_auth(token)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(describe_error)?;
    let status = response.status().as_u16();
    if status != 200 {
        return Ok(SharedTranslationTransfer { status });
    }
    let bytes = read_limited(response, MAX_RECORD_BYTES)
        .await?
        .ok_or_else(|| "RECORD_TOO_LARGE".to_owned())?;
    let text = String::from_utf8(bytes).map_err(|_| "NOT_UTF8".to_owned())?;
    save(root, name, &text)?;
    Ok(SharedTranslationTransfer { status })
}

async fn push(
    client: &Client,
    root: &Path,
    base_url: &str,
    token: &str,
    name: &str,
) -> Result<SharedTranslationTransfer, String> {
    validate_shared_name(name)?;
    let bytes = std::fs::read(record_path(root, name)).map_err(io_err)?;
    let path = format!("{DIR}/{name}");
    let response = client
        .put(file_url(base_url, &[("path", &path), ("baseSha", "")])?)
        .bearer_auth(token)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/octet-stream")
        .timeout(TIMEOUT)
        .body(bytes)
        .send()
        .await
        .map_err(describe_error)?;
    Ok(SharedTranslationTransfer {
        status: response.status().as_u16(),
    })
}

#[tauri::command]
pub async fn canvas_shared_translation_load(
    app: tauri::AppHandle,
    name: String,
) -> Result<Option<String>, String> {
    load(&mirror_root(&app)?, &name)
}

#[tauri::command]
pub async fn canvas_shared_translation_save(
    app: tauri::AppHandle,
    name: String,
    record: String,
) -> Result<(), String> {
    save(&mirror_root(&app)?, &name, &record)
}

#[tauri::command]
pub async fn canvas_shared_translation_pull(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    name: String,
) -> Result<SharedTranslationTransfer, String> {
    let token = require_token(&token)?;
    pull(
        canvas_client()?,
        &mirror_root(&app)?,
        &base_url,
        token,
        &name,
    )
    .await
}

#[tauri::command]
pub async fn canvas_shared_translation_push(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
    name: String,
) -> Result<SharedTranslationTransfer, String> {
    let token = require_token(&token)?;
    push(
        canvas_client()?,
        &mirror_root(&app)?,
        &base_url,
        token,
        &name,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(extra: &[&str]) -> String {
        let mut parts = vec!["a".repeat(64), "b".repeat(64)];
        parts.extend(extra.iter().map(|s| s.to_string()));
        format!("{}.json", parts.join("-"))
    }

    #[test]
    fn names_follow_desktop_translation_regex() {
        assert!(validate_shared_name(&name(&[&"c".repeat(16)])).is_ok());
        assert!(validate_shared_name(&name(&[&"c".repeat(16), &"d".repeat(16)])).is_ok());
        assert!(
            validate_shared_name(&name(&[&"c".repeat(16), &"d".repeat(16), &"e".repeat(16)]))
                .is_ok()
        );
        for bad in [
            name(&[]),
            name(&[&"c".repeat(15)]),
            name(&[&"C".repeat(16)]),
            format!(
                "{}-{}-{}.txt",
                "a".repeat(64),
                "b".repeat(64),
                "c".repeat(16)
            ),
            "../x.json".to_owned(),
        ] {
            assert!(validate_shared_name(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn save_and_load_roundtrip_rejects_non_object() {
        let root = std::env::temp_dir().join(format!("canvas-shared-tr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let n = name(&[&"c".repeat(16)]);
        assert_eq!(load(&root, &n).unwrap(), None);
        save(&root, &n, r#"{"version":2}"#).unwrap();
        assert_eq!(
            load(&root, &n).unwrap().as_deref(),
            Some(r#"{"version":2}"#)
        );
        assert!(save(&root, &n, "[1]").is_err());
        assert!(save(&root, &n, "not json").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
