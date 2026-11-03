//! 附件文件本体同步（手机侧）。
//!
//! 消息同步只传附件元数据与内容哈希；本模块在同一会话内补齐 CAS 文件本体：
//! - Phase 3 push 前：对本批 topic 引用、且本地已有 CAS 的附件 probe，再流式 PUT 缺失项。
//! - 会话完成后：把仍为 `desktop_only` 的附件逐个 GET 到临时文件，边写边算 sha256，
//!   校验通过后 install（rename 进 CAS）并立即 register。两步不拆开：启动 GC 会删除
//!   "文件名像哈希却不在索引里" 的文件，临时文件则按 `.ingest-<hash>-<uuid>.tmp` 命名，
//!   崩溃残留由 GC 回收。
//!
//! 所有失败只写会话日志，不改变消息同步的成功判定。电脑端尚未提供路由（probe 404）时，
//! 本次会话静默跳过附件同步。
use crate::vcp_modules::db_manager::DbState;
use crate::vcp_modules::settings_manager::Settings;
use crate::vcp_modules::sync_logger::{LogLevel, SyncLogger};
use crate::vcp_modules::topic_types::TopicKey;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::StatusCode;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BLOB_ROUTE: &str = "/api/mobile-sync-blob";
const PROBE_CHUNK: usize = 500;
const MAX_PROBE_RESPONSE_BYTES: usize = 1024 * 1024;
const LOG_PHASE: &str = "attachments";

/// `sync.attachmentBlobSync`（fork p8lk4#15），缺省开启。
pub fn attachment_blob_sync_enabled(settings: &Settings) -> bool {
    settings.sync.attachment_blob_sync
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct BlobLimits {
    pub concurrency: usize,
    pub max_session_bytes: u64,
    pub max_file_bytes: u64,
    pub max_retries: u32,
    pub backoff_base: Duration,
}

impl Default for BlobLimits {
    fn default() -> Self {
        Self {
            concurrency: 2,
            max_session_bytes: 1 << 30,
            max_file_bytes: 200 << 20,
            max_retries: 3,
            backoff_base: Duration::from_millis(500),
        }
    }
}

/// 会话级字节预算；上传与下载共用，超出部分留到下次会话。
struct ByteBudget {
    used: AtomicU64,
    limit: u64,
}

impl ByteBudget {
    fn reserve(&self, bytes: u64) -> bool {
        self.used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(bytes).filter(|total| *total <= self.limit)
            })
            .is_ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BlobRef {
    pub hash: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalBlob {
    pub path: PathBuf,
    pub size: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct BlobReport {
    pub transferred: usize,
    pub transferred_bytes: u64,
    pub already_synced: usize,
    pub skipped_budget: usize,
    pub skipped_too_large: usize,
    pub skipped_unavailable: usize,
    pub failed: usize,
    pub route_missing: bool,
    pub disabled: bool,
}

enum Outcome {
    Transferred(u64),
    SkippedBudget,
    SkippedTooLarge,
    Unavailable,
    Failed,
}

impl BlobReport {
    fn record(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Transferred(bytes) => {
                self.transferred += 1;
                self.transferred_bytes += bytes;
            }
            Outcome::SkippedBudget => self.skipped_budget += 1,
            Outcome::SkippedTooLarge => self.skipped_too_large += 1,
            Outcome::Unavailable => self.skipped_unavailable += 1,
            Outcome::Failed => self.failed += 1,
        }
    }

    fn is_empty(&self) -> bool {
        self.transferred
            + self.already_synced
            + self.skipped_budget
            + self.skipped_too_large
            + self.skipped_unavailable
            + self.failed
            == 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StatusClass {
    Success,
    RouteMissing,
    Retryable,
    Fatal,
}

/// 网络错误与 5xx/408/429 可重试；401、413、422 等其余 4xx 不重试。
pub(crate) fn classify_status(status: StatusCode) -> StatusClass {
    if status.is_success() {
        StatusClass::Success
    } else if status == StatusCode::NOT_FOUND {
        StatusClass::RouteMissing
    } else if status.is_server_error()
        || status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
    {
        StatusClass::Retryable
    } else {
        StatusClass::Fatal
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlobErrorKind {
    Retryable,
    Fatal,
    RouteMissing,
}

#[derive(Debug)]
struct BlobError {
    kind: BlobErrorKind,
    message: String,
}

impl BlobError {
    fn retryable(message: impl Into<String>) -> Self {
        Self {
            kind: BlobErrorKind::Retryable,
            message: message.into(),
        }
    }

    fn fatal(message: impl Into<String>) -> Self {
        Self {
            kind: BlobErrorKind::Fatal,
            message: message.into(),
        }
    }

    fn route_missing() -> Self {
        Self {
            kind: BlobErrorKind::RouteMissing,
            message: "附件同步路由不存在 (HTTP 404)".to_string(),
        }
    }
}

fn transport_error(operation: &str, error: reqwest::Error) -> BlobError {
    if error.is_builder() {
        BlobError::fatal(format!("{operation} 请求构造失败: {error}"))
    } else {
        BlobError::retryable(format!("{operation} 网络失败: {error}"))
    }
}

/// 只有 probe 的 404 表示电脑端未升级；对单个 blob 的 404 只说明服务端没有这份文件。
fn status_error(operation: &str, status: StatusCode, probe: bool) -> BlobError {
    match classify_status(status) {
        StatusClass::RouteMissing if probe => BlobError::route_missing(),
        StatusClass::Retryable => BlobError::retryable(format!("{operation} HTTP {status}")),
        _ => BlobError::fatal(format!("{operation} HTTP {status}")),
    }
}

fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn normalize_mime(value: Option<&HeaderValue>) -> String {
    let mime = value
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if mime.contains('/') && !mime.starts_with('/') && !mime.ends_with('/') {
        mime
    } else {
        "application/octet-stream".to_string()
    }
}

fn encode_attachment_name(name: &str) -> String {
    let encoded = urlencoding::encode(name).into_owned();
    if encoded.is_empty() {
        "attachment".to_string()
    } else {
        encoded
    }
}

fn cas_file_name(hash: &str, name: &str) -> String {
    crate::vcp_modules::file_manager::safe_storage_extension(name)
        .map(|extension| format!("{hash}.{extension}"))
        .unwrap_or_else(|| hash.to_string())
}

/// 小写化、过滤非法哈希并按首次出现去重。
fn normalize_refs(refs: Vec<BlobRef>) -> Vec<BlobRef> {
    let mut seen = HashSet::new();
    refs.into_iter()
        .filter_map(|blob| {
            let hash = blob.hash.trim().to_ascii_lowercase();
            (crate::vcp_modules::infra::utils::is_valid_cas_hash(&hash)
                && seen.insert(hash.clone()))
            .then_some(BlobRef {
                hash,
                name: blob.name,
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct ProbeResponse {
    missing: Vec<String>,
}

/// `missing` 必须是本次请求的子集，防止服务端诱导手机上传或下载未请求的哈希。
pub(crate) fn parse_probe_response(
    body: &[u8],
    requested: &[String],
) -> Result<Vec<String>, String> {
    let parsed: ProbeResponse = serde_json::from_slice(body)
        .map_err(|error| format!("probe 响应不是有效 JSON: {error}"))?;
    let requested = requested.iter().map(String::as_str).collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut missing = Vec::new();
    for hash in parsed.missing {
        let hash = hash.to_ascii_lowercase();
        if !requested.contains(hash.as_str()) {
            return Err(format!("probe 响应包含未请求的哈希: {hash}"));
        }
        if seen.insert(hash.clone()) {
            missing.push(hash);
        }
    }
    Ok(missing)
}

/// 未提交的下载临时文件；未 disarm 时析构即删除（错误、取消、哈希不符都走这里）。
struct TempFile {
    path: PathBuf,
    armed: bool,
}

impl TempFile {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

struct Fetched {
    temp: TempFile,
    mime: String,
}

/// 本地 CAS 侧能力；生产实现见 [`TauriBlobLocal`]，测试用内存替身。
pub(crate) trait BlobLocal: Sync {
    fn attachments_root(&self) -> Result<PathBuf, String>;
    fn local_blob(&self, hash: &str) -> impl Future<Output = Option<LocalBlob>> + Send;
    fn desktop_only(&self) -> impl Future<Output = Result<Vec<BlobRef>, String>> + Send;
    fn register(
        &self,
        blob: &BlobRef,
        mime: &str,
        size: u64,
        path: &Path,
    ) -> impl Future<Output = Result<(), String>> + Send;
}

pub(crate) async fn topic_attachment_refs(
    pool: &sqlx::SqlitePool,
    topics: &[TopicKey],
) -> Result<Vec<BlobRef>, String> {
    let mut refs = Vec::new();
    for topic in topics {
        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT ma.hash, MIN(ma.display_name)
             FROM message_attachments ma
             JOIN messages m
               ON m.owner_type = ma.owner_type AND m.owner_id = ma.owner_id
              AND m.topic_id = ma.topic_id AND m.msg_id = ma.msg_id
              AND m.deleted_at IS NULL
             WHERE ma.owner_type = ? AND ma.owner_id = ? AND ma.topic_id = ?
               AND EXISTS (SELECT 1 FROM attachments a WHERE a.hash = ma.hash)
             GROUP BY ma.hash
             ORDER BY ma.hash",
        )
        .bind(&topic.owner_type)
        .bind(&topic.owner_id)
        .bind(&topic.topic_id)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取话题附件失败: {error}"))?;
        refs.extend(rows.into_iter().map(|(hash, name)| BlobRef { hash, name }));
    }
    Ok(refs)
}

pub(crate) async fn desktop_only_refs(pool: &sqlx::SqlitePool) -> Result<Vec<BlobRef>, String> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT ma.hash, MIN(ma.display_name)
         FROM message_attachments ma
         JOIN messages m
           ON m.owner_type = ma.owner_type AND m.owner_id = ma.owner_id
          AND m.topic_id = ma.topic_id AND m.msg_id = ma.msg_id
          AND m.deleted_at IS NULL
         JOIN topics t
           ON t.owner_type = ma.owner_type AND t.owner_id = ma.owner_id
          AND t.topic_id = ma.topic_id AND t.deleted_at IS NULL
         WHERE ma.status = 'desktop_only'
           AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.hash = ma.hash)
         GROUP BY ma.hash
         ORDER BY ma.hash",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取 desktop_only 附件失败: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|(hash, name)| BlobRef { hash, name })
        .collect())
}

pub(crate) struct TauriBlobLocal<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    pool: sqlx::SqlitePool,
}

impl<R: Runtime> BlobLocal for TauriBlobLocal<'_, R> {
    fn attachments_root(&self) -> Result<PathBuf, String> {
        crate::vcp_modules::file_manager::get_attachments_root_dir(self.app)
    }

    async fn local_blob(&self, hash: &str) -> Option<LocalBlob> {
        crate::vcp_modules::file_manager::resolve_attachment_cas_file(self.app, &self.pool, hash)
            .await
            .ok()
            .map(|file| LocalBlob {
                path: file.path,
                size: file.size_bytes,
            })
    }

    async fn desktop_only(&self) -> Result<Vec<BlobRef>, String> {
        desktop_only_refs(&self.pool).await
    }

    async fn register(
        &self,
        blob: &BlobRef,
        mime: &str,
        size: u64,
        path: &Path,
    ) -> Result<(), String> {
        let internal_path = path
            .to_str()
            .ok_or_else(|| "附件目标路径不是有效 UTF-8".to_string())?
            .to_string();
        use tauri::Manager;
        let db = self.app.state::<crate::vcp_modules::db_manager::DbState>();
        crate::vcp_modules::file_manager::commit_registered_attachment(
            &db,
            &blob.hash,
            mime,
            size,
            &internal_path,
            crate::vcp_modules::infra::utils::now_secs() as i64,
        )
        .await
    }
}

/// 一次同步会话内的附件本体同步状态（预算、路由缺失标记在会话内的多个 attempt 间共享）。
pub struct AttachmentBlobSync {
    client: reqwest::Client,
    base_url: String,
    token: String,
    enabled: bool,
    route_missing: AtomicBool,
    budget: ByteBudget,
    limits: BlobLimits,
    logger: Option<Arc<Mutex<SyncLogger>>>,
}

impl AttachmentBlobSync {
    pub fn new(
        client: reqwest::Client,
        base_url: String,
        token: String,
        enabled: bool,
        logger: Option<Arc<Mutex<SyncLogger>>>,
    ) -> Self {
        Self::with_limits(
            client,
            base_url,
            token,
            enabled,
            logger,
            BlobLimits::default(),
        )
    }

    pub(crate) fn with_limits(
        client: reqwest::Client,
        base_url: String,
        token: String,
        enabled: bool,
        logger: Option<Arc<Mutex<SyncLogger>>>,
        limits: BlobLimits,
    ) -> Self {
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
            enabled,
            route_missing: AtomicBool::new(false),
            budget: ByteBudget {
                used: AtomicU64::new(0),
                limit: limits.max_session_bytes,
            },
            limits,
            logger,
        }
    }

    fn is_active(&self) -> bool {
        self.enabled && !self.route_missing.load(Ordering::SeqCst)
    }

    fn url(&self, tail: &str) -> String {
        format!("{}{BLOB_ROUTE}/{tail}", self.base_url)
    }

    fn log(&self, level: LogLevel, message: &str) {
        match level {
            LogLevel::Warning | LogLevel::Error => log::warn!("[AttachmentBlob] {message}"),
            LogLevel::Info => log::info!("[AttachmentBlob] {message}"),
            _ => log::debug!("[AttachmentBlob] {message}"),
        }
        if let Some(logger) = &self.logger {
            if let Ok(mut logger) = logger.lock() {
                logger.log(level, LOG_PHASE, message);
            }
        }
    }

    /// Phase 3 push 前调用：上传本批 topic 引用、且本地已有 CAS 的附件中服务端缺失的部分。
    pub async fn upload_for_topics<R: Runtime>(&self, app: &AppHandle<R>, topics: &[TopicKey]) {
        if !self.is_active() || topics.is_empty() {
            return;
        }
        let pool = app.state::<DbState>().pool.clone();
        let refs = match topic_attachment_refs(&pool, topics).await {
            Ok(refs) => refs,
            Err(error) => {
                self.log(LogLevel::Warning, &format!("附件上传准备失败: {error}"));
                return;
            }
        };
        if refs.is_empty() {
            return;
        }
        let local = TauriBlobLocal { app, pool };
        self.upload_missing(&local, refs).await;
    }

    /// 会话完成后调用：补齐本地仍为 desktop_only 的附件本体。
    pub async fn download_for_session<R: Runtime>(&self, app: &AppHandle<R>) {
        if !self.is_active() {
            return;
        }
        let pool = app.state::<DbState>().pool.clone();
        let local = TauriBlobLocal { app, pool };
        self.download_desktop_only(&local).await;
    }

    pub(crate) async fn upload_missing<L: BlobLocal>(
        &self,
        local: &L,
        refs: Vec<BlobRef>,
    ) -> BlobReport {
        let mut report = BlobReport::default();
        if !self.precheck(&mut report) {
            return report;
        }
        let refs = normalize_refs(refs);
        if refs.is_empty() {
            return report;
        }
        let hashes = refs
            .iter()
            .map(|blob| blob.hash.clone())
            .collect::<Vec<_>>();
        let missing = match self.probe(&hashes).await {
            Ok(missing) => missing,
            Err(error) => {
                self.note_probe_failure("附件上传", error, &mut report);
                return report;
            }
        };
        report.already_synced = refs.len().saturating_sub(missing.len());
        let pending = refs
            .into_iter()
            .filter(|blob| missing.contains(&blob.hash))
            .collect::<Vec<_>>();
        let outcomes = futures_util::stream::iter(pending)
            .map(|blob| async move { self.upload_one(local, blob).await })
            .buffer_unordered(self.limits.concurrency.max(1))
            .collect::<Vec<_>>()
            .await;
        for outcome in outcomes {
            report.record(outcome);
        }
        self.log_summary("附件上传", &report);
        report
    }

    pub(crate) async fn download_desktop_only<L: BlobLocal>(&self, local: &L) -> BlobReport {
        let mut report = BlobReport::default();
        if !self.precheck(&mut report) {
            return report;
        }
        let refs = match local.desktop_only().await {
            Ok(refs) => normalize_refs(refs),
            Err(error) => {
                report.failed += 1;
                self.log(LogLevel::Warning, &format!("附件下载准备失败: {error}"));
                return report;
            }
        };
        if refs.is_empty() {
            return report;
        }
        let root = match local.attachments_root() {
            Ok(root) => root,
            Err(error) => {
                report.failed += 1;
                self.log(LogLevel::Warning, &format!("附件目录不可用: {error}"));
                return report;
            }
        };
        if let Err(error) = tokio::fs::create_dir_all(&root).await {
            report.failed += 1;
            self.log(LogLevel::Warning, &format!("创建附件目录失败: {error}"));
            return report;
        }
        let hashes = refs
            .iter()
            .map(|blob| blob.hash.clone())
            .collect::<Vec<_>>();
        let absent_on_server = match self.probe(&hashes).await {
            Ok(missing) => missing,
            Err(error) => {
                self.note_probe_failure("附件下载", error, &mut report);
                return report;
            }
        };
        report.skipped_unavailable = absent_on_server.len();
        let pending = refs
            .into_iter()
            .filter(|blob| !absent_on_server.contains(&blob.hash))
            .collect::<Vec<_>>();
        let root = root.as_path();
        let outcomes = futures_util::stream::iter(pending)
            .map(|blob| async move { self.download_one(local, root, blob).await })
            .buffer_unordered(self.limits.concurrency.max(1))
            .collect::<Vec<_>>()
            .await;
        for outcome in outcomes {
            report.record(outcome);
        }
        self.log_summary("附件下载", &report);
        report
    }

    fn precheck(&self, report: &mut BlobReport) -> bool {
        if !self.enabled {
            report.disabled = true;
            return false;
        }
        if self.route_missing.load(Ordering::SeqCst) {
            report.route_missing = true;
            return false;
        }
        true
    }

    fn note_probe_failure(&self, label: &str, error: BlobError, report: &mut BlobReport) {
        if error.kind == BlobErrorKind::RouteMissing {
            report.route_missing = true;
            if !self.route_missing.swap(true, Ordering::SeqCst) {
                self.log(
                    LogLevel::Info,
                    "电脑端尚未提供附件文件同步接口 (probe 404)，本次会话跳过附件本体同步",
                );
            }
        } else {
            report.failed += 1;
            self.log(
                LogLevel::Warning,
                &format!("{label} probe 失败: {}", error.message),
            );
        }
    }

    fn log_summary(&self, label: &str, report: &BlobReport) {
        if report.is_empty() {
            return;
        }
        let level = if report.failed > 0 {
            LogLevel::Warning
        } else {
            LogLevel::Info
        };
        self.log(
            level,
            &format!(
                "{label}: 传输 {} 个 ({} 字节)，已同步 {}，预算顺延 {}，超单文件上限 {}，不可用 {}，失败 {}",
                report.transferred,
                report.transferred_bytes,
                report.already_synced,
                report.skipped_budget,
                report.skipped_too_large,
                report.skipped_unavailable,
                report.failed
            ),
        );
    }

    async fn with_retry<T, F, Fut>(&self, operation: &str, mut attempt: F) -> Result<T, BlobError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<T, BlobError>>,
    {
        let mut tries = 0u32;
        loop {
            match attempt().await {
                Err(error)
                    if error.kind == BlobErrorKind::Retryable
                        && tries < self.limits.max_retries =>
                {
                    let delay = self
                        .limits
                        .backoff_base
                        .saturating_mul(1u32 << tries.min(16));
                    tries += 1;
                    self.log(
                        LogLevel::Debug,
                        &format!(
                            "{operation} 第 {tries}/{} 次重试 ({delay:?} 后): {}",
                            self.limits.max_retries, error.message
                        ),
                    );
                    tokio::time::sleep(delay).await;
                }
                other => return other,
            }
        }
    }

    async fn probe(&self, hashes: &[String]) -> Result<HashSet<String>, BlobError> {
        let mut missing = HashSet::new();
        for chunk in hashes.chunks(PROBE_CHUNK) {
            let found = self.with_retry("probe", || self.probe_chunk(chunk)).await?;
            missing.extend(found);
        }
        Ok(missing)
    }

    async fn probe_chunk(&self, chunk: &[String]) -> Result<Vec<String>, BlobError> {
        let response = self
            .client
            .post(self.url("probe"))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "hashes": chunk }))
            .send()
            .await
            .map_err(|error| transport_error("probe", error))?;
        let status = response.status();
        if !status.is_success() {
            return Err(status_error("probe", status, true));
        }
        if declared_length(response.headers())
            .is_some_and(|length| length > MAX_PROBE_RESPONSE_BYTES as u64)
        {
            return Err(BlobError::fatal("probe 响应过大"));
        }
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|error| BlobError::retryable(format!("probe 响应读取失败: {error}")))?;
            if body.len().saturating_add(chunk.len()) > MAX_PROBE_RESPONSE_BYTES {
                return Err(BlobError::fatal("probe 响应过大"));
            }
            body.extend_from_slice(&chunk);
        }
        parse_probe_response(&body, chunk).map_err(BlobError::fatal)
    }

    async fn upload_one<L: BlobLocal>(&self, local: &L, blob: BlobRef) -> Outcome {
        let Some(file) = local.local_blob(&blob.hash).await else {
            self.log(
                LogLevel::Debug,
                &format!("附件 {} 本地 CAS 不可用，跳过上传", blob.hash),
            );
            return Outcome::Unavailable;
        };
        if file.size > self.limits.max_file_bytes {
            self.log(
                LogLevel::Info,
                &format!(
                    "附件 {} 大小 {} 超过单文件上限，跳过上传",
                    blob.hash, file.size
                ),
            );
            return Outcome::SkippedTooLarge;
        }
        if !self.budget.reserve(file.size) {
            self.log(
                LogLevel::Debug,
                &format!("附件 {} 超出本次会话字节预算，留到下次", blob.hash),
            );
            return Outcome::SkippedBudget;
        }
        match self
            .with_retry("附件上传", || self.put_blob(&blob, &file))
            .await
        {
            Ok(()) => Outcome::Transferred(file.size),
            Err(error) => {
                self.log(
                    LogLevel::Warning,
                    &format!("附件 {} 上传失败: {}", blob.hash, error.message),
                );
                Outcome::Failed
            }
        }
    }

    async fn put_blob(&self, blob: &BlobRef, file: &LocalBlob) -> Result<(), BlobError> {
        let handle = tokio::fs::File::open(&file.path)
            .await
            .map_err(|error| BlobError::fatal(format!("打开本地附件失败: {error}")))?;
        let actual = handle
            .metadata()
            .await
            .map_err(|error| BlobError::fatal(format!("读取本地附件元数据失败: {error}")))?
            .len();
        if actual != file.size {
            return Err(BlobError::fatal("本地附件大小与 CAS 索引不一致"));
        }
        // 流式读取 CAS 文件，不把整份附件读进内存。
        let stream = tokio_util::io::ReaderStream::new(handle.take(file.size));
        let response = self
            .client
            .put(self.url(&blob.hash))
            .bearer_auth(&self.token)
            .header(CONTENT_LENGTH, file.size)
            // 电脑侧只接受 octet-stream（其余返回 415）；扩展名由 X-Attachment-Name 提供。
            .header(CONTENT_TYPE, "application/octet-stream")
            .header("X-Attachment-Name", encode_attachment_name(&blob.name))
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .map_err(|error| transport_error("附件上传", error))?;
        let status = response.status();
        if status == StatusCode::CREATED || status == StatusCode::OK {
            Ok(())
        } else {
            Err(status_error("附件上传", status, false))
        }
    }

    async fn download_one<L: BlobLocal>(&self, local: &L, root: &Path, blob: BlobRef) -> Outcome {
        let size = match self
            .with_retry("附件 HEAD", || self.head_size(&blob.hash))
            .await
        {
            Ok(size) => size,
            Err(error) => {
                self.log(
                    LogLevel::Warning,
                    &format!("附件 {} 查询失败: {}", blob.hash, error.message),
                );
                return Outcome::Failed;
            }
        };
        if size > self.limits.max_file_bytes {
            self.log(
                LogLevel::Info,
                &format!("附件 {} 大小 {size} 超过单文件上限，跳过下载", blob.hash),
            );
            return Outcome::SkippedTooLarge;
        }
        if !self.budget.reserve(size) {
            self.log(
                LogLevel::Debug,
                &format!("附件 {} 超出本次会话字节预算，留到下次", blob.hash),
            );
            return Outcome::SkippedBudget;
        }
        let mut fetched = match self
            .with_retry("附件下载", || {
                self.fetch_to_temp(root, &blob.hash, size)
            })
            .await
        {
            Ok(fetched) => fetched,
            Err(error) => {
                self.log(
                    LogLevel::Warning,
                    &format!("附件 {} 下载失败: {}", blob.hash, error.message),
                );
                return Outcome::Failed;
            }
        };

        // rename 进 CAS 后立即注册，中间不插入其他 await 点之外的工作。
        let dest = root.join(cas_file_name(&blob.hash, &blob.name));
        if let Err(error) = install_verified_upload(fetched.temp.path(), &dest, size).await {
            self.log(
                LogLevel::Warning,
                &format!("附件 {} 安装失败: {error}", blob.hash),
            );
            return Outcome::Failed;
        }
        fetched.temp.disarm();
        if let Err(error) = local.register(&blob, &fetched.mime, size, &dest).await {
            // 未登记的 CAS 文件由下次启动 GC 回收；这里不删，避免误删并发安装的同哈希胜者。
            self.log(
                LogLevel::Warning,
                &format!("附件 {} 注册失败: {error}", blob.hash),
            );
            return Outcome::Failed;
        }
        Outcome::Transferred(size)
    }

    async fn head_size(&self, hash: &str) -> Result<u64, BlobError> {
        let response = self
            .client
            .head(self.url(hash))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| transport_error("附件 HEAD", error))?;
        let status = response.status();
        if !status.is_success() {
            return Err(status_error("附件 HEAD", status, false));
        }
        // HEAD 没有 body，reqwest::Response::content_length 可能给 0，直接读头。
        declared_length(response.headers())
            .ok_or_else(|| BlobError::fatal("附件 HEAD 缺少 Content-Length"))
    }

    async fn fetch_to_temp(
        &self,
        root: &Path,
        hash: &str,
        expected: u64,
    ) -> Result<Fetched, BlobError> {
        let temp = TempFile::new(root.join(format!(".ingest-{hash}-{}.tmp", uuid::Uuid::new_v4())));
        let response = self
            .client
            .get(self.url(hash))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| transport_error("附件下载", error))?;
        let status = response.status();
        if status != StatusCode::OK {
            return Err(if status.is_success() {
                BlobError::fatal(format!("附件下载返回非完整响应 HTTP {status}"))
            } else {
                status_error("附件下载", status, false)
            });
        }
        if declared_length(response.headers()).is_some_and(|length| length != expected) {
            return Err(BlobError::fatal("附件下载 Content-Length 与 HEAD 不一致"));
        }
        let mime = normalize_mime(response.headers().get(CONTENT_TYPE));
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp.path())
            .await
            .map_err(|error| BlobError::fatal(format!("创建附件临时文件失败: {error}")))?;
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|error| BlobError::retryable(format!("附件下载中断: {error}")))?;
            written = written.saturating_add(chunk.len() as u64);
            if written > expected {
                return Err(BlobError::fatal("附件下载超出声明大小"));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| BlobError::fatal(format!("写入附件临时文件失败: {error}")))?;
        }
        file.flush()
            .await
            .map_err(|error| BlobError::fatal(format!("刷新附件临时文件失败: {error}")))?;
        file.sync_all()
            .await
            .map_err(|error| BlobError::fatal(format!("落盘附件临时文件失败: {error}")))?;
        drop(file);
        if written != expected {
            return Err(BlobError::retryable(format!(
                "附件下载不完整: {written}/{expected}"
            )));
        }
        let actual = hex::encode(hasher.finalize());
        if actual != hash {
            return Err(BlobError::fatal(format!(
                "附件哈希不符: 期望 {hash}，实际 {actual}"
            )));
        }
        Ok(Fetched { temp, mime })
    }
}

/// 把已校验的临时文件落进 CAS。目标已存在（同哈希并发写入或历史文件）时只按尺寸复用。
/// 落位写法与上游 `file_manager` CAS 一致：同目录 `rename`，失败后仅接受已存在且尺寸正确的胜者。
async fn install_verified_upload(
    temp_path: &Path,
    dest_path: &Path,
    expected_size: u64,
) -> Result<(), String> {
    if !dest_path.exists() {
        if let Err(error) = tokio::fs::rename(temp_path, dest_path).await {
            if !dest_path.exists() {
                return Err(format!("附件移动失败: {error}"));
            }
        }
    }

    crate::vcp_modules::file_manager::check_existing_cas_size_async(dest_path, expected_size)
        .await?;

    if temp_path.exists() {
        tokio::fs::remove_file(temp_path)
            .await
            .map_err(|error| format!("清理已验证的重复附件临时文件失败: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod install_tests {
    use super::install_verified_upload;

    #[tokio::test]
    async fn existing_cas_is_reused_by_size_gate_and_temp_is_discarded() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("upload.tmp");
        let destination = temp.path().join("cas.bin");
        let expected = b"expected";

        // 尺寸不符（截断/半文件）的已有 CAS：拒绝复用，暂存文件保留以便重试。
        std::fs::write(&source, expected).expect("source");
        std::fs::write(&destination, b"bad").expect("truncated destination");
        assert!(
            install_verified_upload(&source, &destination, expected.len() as u64)
                .await
                .is_err()
        );
        assert!(
            source.exists(),
            "unverified upload temp must remain retryable"
        );

        // 尺寸匹配的已有 CAS：文件名即内容哈希 + 原子发布，直接复用并清理暂存。
        std::fs::write(&destination, expected).expect("valid destination");
        install_verified_upload(&source, &destination, expected.len() as u64)
            .await
            .expect("matching CAS should be reusable");
        assert!(
            !source.exists(),
            "verified duplicate temp should be removed"
        );
    }

    #[tokio::test]
    async fn newly_installed_upload_is_verified_after_atomic_move() {
        let temp = tempfile::tempdir().expect("tempdir");
        let source = temp.path().join("upload.tmp");
        let destination = temp.path().join("cas.bin");
        let expected = b"new-cas";
        std::fs::write(&source, expected).expect("source");

        install_verified_upload(&source, &destination, expected.len() as u64)
            .await
            .expect("new CAS should install");
        assert!(!source.exists());
        assert_eq!(std::fs::read(destination).expect("destination"), expected);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::extract::{Path as AxPath, State};
    use axum::http::{header, HeaderMap as AxHeaderMap, StatusCode as AxStatus};
    use axum::response::{IntoResponse, Response};
    use axum::routing::{post, put};
    use axum::{Json, Router};
    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    #[derive(Default)]
    struct ServerState {
        blobs: HashMap<String, Vec<u8>>,
        put_calls: usize,
        put_names: Vec<String>,
        put_content_types: Vec<String>,
        put_failures: usize,
        put_status: Option<u16>,
    }

    type Shared = Arc<Mutex<ServerState>>;

    #[derive(Deserialize)]
    struct ProbeBody {
        hashes: Vec<String>,
    }

    async fn probe_handler(
        State(state): State<Shared>,
        Json(body): Json<ProbeBody>,
    ) -> Json<serde_json::Value> {
        let state = state.lock().unwrap();
        let missing = body
            .hashes
            .into_iter()
            .filter(|hash| !state.blobs.contains_key(hash))
            .collect::<Vec<_>>();
        Json(serde_json::json!({ "missing": missing }))
    }

    async fn put_handler(
        State(state): State<Shared>,
        AxPath(hash): AxPath<String>,
        headers: AxHeaderMap,
        body: Bytes,
    ) -> AxStatus {
        let mut state = state.lock().unwrap();
        state.put_calls += 1;
        let content_type = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        state.put_content_types.push(content_type);
        if let Some(code) = state.put_status {
            return AxStatus::from_u16(code).unwrap();
        }
        if state.put_failures > 0 {
            state.put_failures -= 1;
            return AxStatus::SERVICE_UNAVAILABLE;
        }
        if sha(&body) != hash {
            return AxStatus::UNPROCESSABLE_ENTITY;
        }
        if let Some(name) = headers
            .get("x-attachment-name")
            .and_then(|value| value.to_str().ok())
        {
            state.put_names.push(name.to_string());
        }
        if state.blobs.insert(hash, body.to_vec()).is_some() {
            AxStatus::OK
        } else {
            AxStatus::CREATED
        }
    }

    async fn get_handler(State(state): State<Shared>, AxPath(hash): AxPath<String>) -> Response {
        match state.lock().unwrap().blobs.get(&hash) {
            Some(bytes) => ([(header::CONTENT_TYPE, "image/png")], bytes.clone()).into_response(),
            None => AxStatus::NOT_FOUND.into_response(),
        }
    }

    async fn head_handler(State(state): State<Shared>, AxPath(hash): AxPath<String>) -> Response {
        match state.lock().unwrap().blobs.get(&hash) {
            Some(bytes) => (
                AxStatus::OK,
                [(header::CONTENT_LENGTH, bytes.len().to_string())],
            )
                .into_response(),
            None => AxStatus::NOT_FOUND.into_response(),
        }
    }

    async fn spawn(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        format!("http://{address}")
    }

    async fn blob_server(state: Shared) -> String {
        let router = Router::new()
            .route("/api/mobile-sync-blob/probe", post(probe_handler))
            .route(
                "/api/mobile-sync-blob/{hash}",
                put(put_handler).get(get_handler).head(head_handler),
            )
            .with_state(state);
        spawn(router).await
    }

    fn test_limits() -> BlobLimits {
        BlobLimits {
            backoff_base: Duration::from_millis(1),
            ..BlobLimits::default()
        }
    }

    fn sync(base: String, limits: BlobLimits) -> AttachmentBlobSync {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        AttachmentBlobSync::with_limits(client, base, "token".into(), true, None, limits)
    }

    struct FakeLocal {
        root: PathBuf,
        blobs: HashMap<String, LocalBlob>,
        desktop: Vec<BlobRef>,
        registered: Mutex<Vec<(String, PathBuf, String)>>,
    }

    impl FakeLocal {
        fn new(root: &Path) -> Self {
            Self {
                root: root.to_path_buf(),
                blobs: HashMap::new(),
                desktop: Vec::new(),
                registered: Mutex::new(Vec::new()),
            }
        }

        fn add_local(&mut self, name: &str, bytes: &[u8]) -> BlobRef {
            let hash = sha(bytes);
            let path = self.root.join(&hash);
            std::fs::write(&path, bytes).unwrap();
            self.blobs.insert(
                hash.clone(),
                LocalBlob {
                    path,
                    size: bytes.len() as u64,
                },
            );
            BlobRef {
                hash,
                name: name.into(),
            }
        }

        fn temp_files(&self) -> Vec<String> {
            std::fs::read_dir(&self.root)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .filter(|name| name.ends_with(".tmp"))
                        .collect()
                })
                .unwrap_or_default()
        }
    }

    impl BlobLocal for FakeLocal {
        fn attachments_root(&self) -> Result<PathBuf, String> {
            Ok(self.root.clone())
        }

        async fn local_blob(&self, hash: &str) -> Option<LocalBlob> {
            self.blobs.get(hash).cloned()
        }

        async fn desktop_only(&self) -> Result<Vec<BlobRef>, String> {
            Ok(self.desktop.clone())
        }

        async fn register(
            &self,
            blob: &BlobRef,
            mime: &str,
            size: u64,
            path: &Path,
        ) -> Result<(), String> {
            // 注册发生时 CAS 文件必须已经 rename 到位，临时文件已不存在。
            assert!(path.is_file(), "CAS file must exist before register");
            assert_eq!(std::fs::metadata(path).unwrap().len(), size);
            assert!(
                self.temp_files().is_empty(),
                "temp file must be consumed before register"
            );
            self.registered.lock().unwrap().push((
                blob.hash.clone(),
                path.to_path_buf(),
                mime.to_string(),
            ));
            Ok(())
        }
    }

    #[test]
    fn probe_response_is_normalized_and_bounded_to_the_request() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let requested = vec![a.clone(), b.clone()];
        let body = format!(r#"{{"missing":["{}","{a}"]}}"#, a.to_ascii_uppercase());
        assert_eq!(
            parse_probe_response(body.as_bytes(), &requested).unwrap(),
            vec![a.clone()]
        );
        assert_eq!(
            parse_probe_response(br#"{"missing":[]}"#, &requested).unwrap(),
            Vec::<String>::new()
        );

        let foreign = format!(r#"{{"missing":["{}"]}}"#, "c".repeat(64));
        assert!(parse_probe_response(foreign.as_bytes(), &requested).is_err());
        assert!(parse_probe_response(b"not json", &requested).is_err());
        assert!(parse_probe_response(br#"{"present":[]}"#, &requested).is_err());
    }

    #[test]
    fn status_classification_separates_retryable_from_terminal_failures() {
        assert_eq!(classify_status(StatusCode::CREATED), StatusClass::Success);
        assert_eq!(classify_status(StatusCode::OK), StatusClass::Success);
        assert_eq!(
            classify_status(StatusCode::NOT_FOUND),
            StatusClass::RouteMissing
        );
        for retryable in [500, 502, 503, 504, 408, 429] {
            assert_eq!(
                classify_status(StatusCode::from_u16(retryable).unwrap()),
                StatusClass::Retryable,
                "{retryable}"
            );
        }
        for fatal in [401, 403, 413, 422, 400] {
            assert_eq!(
                classify_status(StatusCode::from_u16(fatal).unwrap()),
                StatusClass::Fatal,
                "{fatal}"
            );
        }
        // 单个 blob 的 404 不是路由缺失。
        assert_eq!(
            status_error("x", StatusCode::NOT_FOUND, false).kind,
            BlobErrorKind::Fatal
        );
        assert_eq!(
            status_error("x", StatusCode::NOT_FOUND, true).kind,
            BlobErrorKind::RouteMissing
        );
    }

    #[test]
    fn settings_flag_defaults_on_and_respects_explicit_false() {
        let mut settings = Settings::default();
        assert!(attachment_blob_sync_enabled(&settings));
        settings.sync.attachment_blob_sync = false;
        assert!(!attachment_blob_sync_enabled(&settings));
        let legacy: Settings = serde_json::from_value(serde_json::json!({ "sync": {} }))
            .expect("missing field uses default");
        assert!(attachment_blob_sync_enabled(&legacy));
    }

    #[tokio::test]
    async fn upload_sends_only_hashes_reported_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mut local = FakeLocal::new(dir.path());
        let present = local.add_local("present.png", b"already-on-desktop");
        let absent = local.add_local("新 图.png", b"only-on-mobile");
        let state = Shared::default();
        state
            .lock()
            .unwrap()
            .blobs
            .insert(present.hash.clone(), b"already-on-desktop".to_vec());
        let blob = sync(blob_server(state.clone()).await, test_limits());

        let report = blob
            .upload_missing(&local, vec![present.clone(), absent.clone()])
            .await;

        assert_eq!(report.transferred, 1);
        assert_eq!(report.already_synced, 1);
        assert_eq!(report.failed, 0);
        let state = state.lock().unwrap();
        assert_eq!(state.put_calls, 1);
        assert_eq!(state.blobs.get(&absent.hash).unwrap(), b"only-on-mobile");
        assert_eq!(
            state.put_names,
            vec![urlencoding::encode("新 图.png").into_owned()]
        );
        assert_eq!(
            state.put_content_types,
            vec!["application/octet-stream".to_string()]
        );
    }

    #[tokio::test]
    async fn download_installs_then_registers_verified_blob() {
        let dir = tempfile::tempdir().unwrap();
        let mut local = FakeLocal::new(dir.path());
        let bytes = b"desktop-photo".to_vec();
        let hash = sha(&bytes);
        local.desktop.push(BlobRef {
            hash: hash.clone(),
            name: "photo.PNG".into(),
        });
        let state = Shared::default();
        state
            .lock()
            .unwrap()
            .blobs
            .insert(hash.clone(), bytes.clone());
        let blob = sync(blob_server(state).await, test_limits());

        let report = blob.download_desktop_only(&local).await;

        assert_eq!(report.transferred, 1, "{report:?}");
        let registered = local.registered.lock().unwrap().clone();
        let expected_path = dir.path().join(format!("{hash}.PNG"));
        assert_eq!(
            registered,
            vec![(hash, expected_path.clone(), "image/png".to_string())]
        );
        assert_eq!(std::fs::read(expected_path).unwrap(), bytes);
        assert!(local.temp_files().is_empty());
    }

    #[tokio::test]
    async fn download_with_hash_mismatch_is_discarded_and_not_registered() {
        let dir = tempfile::tempdir().unwrap();
        let mut local = FakeLocal::new(dir.path());
        let claimed = sha(b"genuine");
        local.desktop.push(BlobRef {
            hash: claimed.clone(),
            name: "x.bin".into(),
        });
        let state = Shared::default();
        state
            .lock()
            .unwrap()
            .blobs
            .insert(claimed.clone(), b"tampered".to_vec());
        let blob = sync(blob_server(state).await, test_limits());

        let report = blob.download_desktop_only(&local).await;

        assert_eq!(report.failed, 1);
        assert_eq!(report.transferred, 0);
        assert!(local.registered.lock().unwrap().is_empty());
        let leftovers = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(leftovers, 0, "neither temp nor CAS file may remain");
    }

    #[tokio::test]
    async fn session_budget_and_file_limit_defer_excess_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let mut local = FakeLocal::new(dir.path());
        let first = local.add_local("a.bin", b"12345678");
        let second = local.add_local("b.bin", b"abcdefgh");
        let large = local.add_local("c.bin", b"0123456789abcdef");
        let state = Shared::default();
        let limits = BlobLimits {
            max_session_bytes: 10,
            max_file_bytes: 12,
            ..test_limits()
        };
        let blob = sync(blob_server(state.clone()).await, limits);

        let report = blob
            .upload_missing(&local, vec![first, second, large])
            .await;

        assert_eq!(report.transferred, 1, "{report:?}");
        assert_eq!(report.skipped_budget, 1);
        assert_eq!(report.skipped_too_large, 1);
        assert_eq!(state.lock().unwrap().put_calls, 1);
    }

    #[tokio::test]
    async fn missing_route_silently_disables_the_rest_of_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let mut local = FakeLocal::new(dir.path());
        let blob_ref = local.add_local("a.bin", b"payload");
        local.desktop.push(BlobRef {
            hash: sha(b"other"),
            name: "o.bin".into(),
        });
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let router = Router::new().fallback(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                AxStatus::NOT_FOUND
            }
        });
        let blob = sync(spawn(router).await, test_limits());

        let upload = blob.upload_missing(&local, vec![blob_ref]).await;
        let download = blob.download_desktop_only(&local).await;

        assert!(upload.route_missing);
        assert_eq!(upload.failed, 0);
        assert!(download.route_missing);
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "only the first probe may hit the server"
        );
    }

    #[tokio::test]
    async fn transient_failures_retry_but_rejections_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let mut local = FakeLocal::new(dir.path());
        let flaky = local.add_local("flaky.bin", b"flaky");
        let rejected = local.add_local("rejected.bin", b"rejected");

        let state = Shared::default();
        state.lock().unwrap().put_failures = 2;
        let blob = sync(blob_server(state.clone()).await, test_limits());
        let report = blob.upload_missing(&local, vec![flaky]).await;
        assert_eq!(report.transferred, 1);
        assert_eq!(state.lock().unwrap().put_calls, 3);

        for code in [422u16, 413, 401] {
            let state = Shared::default();
            state.lock().unwrap().put_status = Some(code);
            let blob = sync(blob_server(state.clone()).await, test_limits());
            let report = blob.upload_missing(&local, vec![rejected.clone()]).await;
            assert_eq!(report.failed, 1, "{code}");
            assert_eq!(
                state.lock().unwrap().put_calls,
                1,
                "{code} must not be retried"
            );
        }

        let state = Shared::default();
        state.lock().unwrap().put_failures = 10;
        let blob = sync(blob_server(state.clone()).await, test_limits());
        let report = blob.upload_missing(&local, vec![rejected]).await;
        assert_eq!(report.failed, 1);
        assert_eq!(
            state.lock().unwrap().put_calls,
            4,
            "one attempt plus three retries"
        );
    }

    #[tokio::test]
    async fn disabled_sync_never_contacts_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let mut local = FakeLocal::new(dir.path());
        let blob_ref = local.add_local("a.bin", b"payload");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        // 不可达地址：若误发请求会记为失败而不是 disabled。
        let blob = AttachmentBlobSync::with_limits(
            client,
            "http://127.0.0.1:9".into(),
            "token".into(),
            false,
            None,
            test_limits(),
        );
        let upload = blob.upload_missing(&local, vec![blob_ref]).await;
        let download = blob.download_desktop_only(&local).await;
        assert!(upload.disabled && download.disabled);
        assert_eq!(upload.failed + download.failed, 0);
    }

    #[tokio::test]
    async fn local_queries_select_live_unindexed_desktop_only_and_indexed_topic_hashes() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let [h1, h2, h3, h4] = ["1", "2", "3", "4"].map(|digit| digit.repeat(64));
        sqlx::query(
            "CREATE TABLE attachments (hash TEXT PRIMARY KEY);
             CREATE TABLE messages (owner_type TEXT, owner_id TEXT, topic_id TEXT, msg_id TEXT, deleted_at INTEGER);
             CREATE TABLE topics (owner_type TEXT, owner_id TEXT, topic_id TEXT, deleted_at INTEGER);
             CREATE TABLE message_attachments (
                owner_type TEXT, owner_id TEXT, topic_id TEXT, msg_id TEXT,
                hash TEXT, display_name TEXT, status TEXT
             );
             INSERT INTO topics VALUES ('agent', 'a', 't', NULL);
             INSERT INTO messages VALUES
                ('agent', 'a', 't', 'live', NULL), ('agent', 'a', 't', 'gone', 9);",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO attachments VALUES (?)")
            .bind(&h3)
            .execute(&pool)
            .await
            .unwrap();
        for (msg_id, hash, name, status) in [
            ("live", &h1, "one.png", "desktop_only"),
            ("gone", &h2, "two.png", "desktop_only"),
            ("live", &h3, "three.png", "desktop_only"),
            ("live", &h4, "four.png", "ready"),
        ] {
            sqlx::query("INSERT INTO message_attachments VALUES ('agent', 'a', 't', ?, ?, ?, ?)")
                .bind(msg_id)
                .bind(hash)
                .bind(name)
                .bind(status)
                .execute(&pool)
                .await
                .unwrap();
        }

        let desktop = desktop_only_refs(&pool).await.unwrap();
        assert_eq!(
            desktop,
            vec![BlobRef {
                hash: h1,
                name: "one.png".into()
            }]
        );
        let topic = topic_attachment_refs(&pool, &[TopicKey::new("agent", "a", "t")])
            .await
            .unwrap();
        assert_eq!(
            topic,
            vec![BlobRef {
                hash: h3,
                name: "three.png".into()
            }]
        );
    }
}
