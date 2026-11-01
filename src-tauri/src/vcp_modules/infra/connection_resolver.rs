//! 聊天连接档案解析：本机 / 服务器 / 自动（ptp4g#5）。
//!
//! 数据模型沿用桌面端 `modules/services/connectionProfiles.js`（c69bd3fc）：
//! `connectionProfiles: [{ name, vcpServerUrl, vcpApiKey }]`。手机端固定
//! `本机` / `服务器` 两档，经 `Settings.extra`（serde flatten）原样落盘。
//! 档位字段 `connectionProfileMode = local | server | auto`；缺失或非法时逐字节沿用
//! `vcp_server_url / vcp_api_key`，老用户无感。
//!
//! 职责边界：
//! - `resolve_vcp_connection` 同步、只读一份进程级探测记录，可在任何请求出口调用；
//! - auto 探测是异步任务（GET 本机 origin `/v1/models`，Bearer，2.5s 超时，30s 缓存），
//!   由前端在启动 / 回前台 / 网络变化 / 档案变更时 invoke 触发；请求出口建立连接失败时补报；
//! - 本机由「可达/未知」变为「不可达」时 emit 一次 `vcp-connection-fallback`，
//!   前端 toastOnly 提示，不随每条请求重复；
//! - 同步地址（syncServerUrl / syncHttpUrl / syncToken）不经过本模块。

use super::http_clients::{client, HttpProfile};
use crate::vcp_modules::settings_manager::{read_settings, Settings, SettingsState};
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

pub const PROFILE_MODE_KEY: &str = "connectionProfileMode";
pub const PROFILES_KEY: &str = "connectionProfiles";
pub const LOCAL_PROFILE_NAME: &str = "本机";
pub const SERVER_PROFILE_NAME: &str = "服务器";
pub const FALLBACK_EVENT: &str = "vcp-connection-fallback";
const PROBE_TIMEOUT: Duration = Duration::from_millis(2500);
const PROBE_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileMode {
    Local,
    Server,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionSource {
    Legacy,
    Local,
    Server,
}

#[cfg_attr(test, derive(Debug))]
#[derive(Clone)]
struct Profile {
    url: String,
    key: String,
}

/// 探测对象：本机档案的 origin + key。档案改动后旧记录自然失配（视为未知）。
#[derive(Clone, PartialEq, Eq)]
struct ProbeTarget {
    origin: String,
    key: String,
}

#[derive(Clone)]
struct ProbeRecord {
    target: ProbeTarget,
    reachable: bool,
    checked_at: Instant,
}

#[cfg_attr(test, derive(Debug))]
#[derive(Clone, PartialEq, Eq)]
struct ResolvedConnection {
    url: String,
    key: String,
    source: ConnectionSource,
}

static PROBE_RECORD: RwLock<Option<ProbeRecord>> = RwLock::new(None);
static PROBE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

fn profile_mode(settings: &Settings) -> Option<ProfileMode> {
    match settings.extra.get(PROFILE_MODE_KEY)?.as_str()? {
        "local" => Some(ProfileMode::Local),
        "server" => Some(ProfileMode::Server),
        "auto" => Some(ProfileMode::Auto),
        _ => None,
    }
}

/// 读取指定档案；URL 为空视为未配置。
fn profile(settings: &Settings, name: &str) -> Option<Profile> {
    let entry = settings
        .extra
        .get(PROFILES_KEY)?
        .as_array()?
        .iter()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))?;
    let url = entry.get("vcpServerUrl").and_then(Value::as_str)?.trim();
    if url.is_empty() {
        return None;
    }
    let key = entry
        .get("vcpApiKey")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Some(Profile {
        url: url.to_string(),
        key: key.to_string(),
    })
}

fn origin_of(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let origin = url.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

fn probe_target(profile: &Profile) -> Option<ProbeTarget> {
    Some(ProbeTarget {
        origin: origin_of(&profile.url)?,
        key: profile.key.clone(),
    })
}

/// 只有 auto 档且两档俱全时才需要探测；返回本机探测对象。
fn auto_probe_target(settings: &Settings) -> Option<ProbeTarget> {
    if profile_mode(settings) != Some(ProfileMode::Auto)
        || profile(settings, SERVER_PROFILE_NAME).is_none()
    {
        return None;
    }
    probe_target(&profile(settings, LOCAL_PROFILE_NAME)?)
}

fn local_marked_unreachable(local: &Profile, record: Option<&ProbeRecord>) -> bool {
    match (probe_target(local), record) {
        (Some(target), Some(record)) => record.target == target && !record.reachable,
        _ => false,
    }
}

/// 纯选择逻辑：auto 下本机「可达或未知」用本机，「不可达」用服务器；缺档回落旧字段。
fn select_connection(settings: &Settings, record: Option<&ProbeRecord>) -> ResolvedConnection {
    let chosen = profile_mode(settings).and_then(|mode| {
        let local = profile(settings, LOCAL_PROFILE_NAME);
        let server = profile(settings, SERVER_PROFILE_NAME);
        match (mode, local, server) {
            (ProfileMode::Local, Some(local), _) => Some((local, ConnectionSource::Local)),
            (ProfileMode::Server, _, Some(server)) => Some((server, ConnectionSource::Server)),
            (ProfileMode::Auto, Some(local), Some(server)) => {
                if local_marked_unreachable(&local, record) {
                    Some((server, ConnectionSource::Server))
                } else {
                    Some((local, ConnectionSource::Local))
                }
            }
            (ProfileMode::Auto, Some(local), None) => Some((local, ConnectionSource::Local)),
            (ProfileMode::Auto, None, Some(server)) => Some((server, ConnectionSource::Server)),
            _ => None,
        }
    });
    match chosen {
        Some((profile, source)) => ResolvedConnection {
            url: profile.url,
            key: profile.key,
            source,
        },
        None => ResolvedConnection {
            url: settings.vcp_server_url.clone(),
            key: settings.vcp_api_key.clone(),
            source: ConnectionSource::Legacy,
        },
    }
}

fn read_record() -> RwLockReadGuard<'static, Option<ProbeRecord>> {
    PROBE_RECORD
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn resolve(settings: &Settings) -> ResolvedConnection {
    let record = read_record();
    select_connection(settings, record.as_ref())
}

/// 当前生效的聊天端点 `(url, key)`。同步只读，可在任意请求出口调用。
pub fn resolve_vcp_connection(settings: &Settings) -> (String, String) {
    let resolved = resolve(settings);
    (resolved.url, resolved.key)
}

/// 返回把 `vcp_server_url / vcp_api_key` 替换为生效端点的设置副本，并移除档位键，
/// 使下游再次解析成为恒等操作（同一次请求内 url 与 key 不会被探测翻转拆散）。
/// 仅用于构造请求，不得写回持久化。
pub fn resolved_settings(mut settings: Settings) -> Settings {
    let resolved = resolve(&settings);
    settings.vcp_server_url = resolved.url;
    settings.vcp_api_key = resolved.key;
    if let Some(extra) = settings.extra.as_object_mut() {
        extra.remove(PROFILE_MODE_KEY);
    }
    settings
}

/// 是否需要重新探测：目标变化或距上次探测满 30s。
fn needs_probe(record: Option<&ProbeRecord>, target: &ProbeTarget, now: Instant) -> bool {
    match record {
        Some(record) if &record.target == target => {
            now.saturating_duration_since(record.checked_at) >= PROBE_CACHE_TTL
        }
        _ => true,
    }
}

/// 写入探测结果；返回 true 表示本次由「可达/未知」进入「不可达」，需要提示一次。
fn record_probe_result(
    slot: &mut Option<ProbeRecord>,
    target: ProbeTarget,
    reachable: bool,
    now: Instant,
) -> bool {
    let already_unreachable = slot
        .as_ref()
        .is_some_and(|record| record.target == target && !record.reachable);
    *slot = Some(ProbeRecord {
        target,
        reachable,
        checked_at: now,
    });
    !reachable && !already_unreachable
}

fn commit_probe_result(target: ProbeTarget, reachable: bool) -> bool {
    let mut slot = PROBE_RECORD
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    record_probe_result(&mut slot, target, reachable, Instant::now())
}

async fn probe_local(client: &Client, target: &ProbeTarget, timeout: Duration) -> bool {
    let url = format!("{}/v1/models", target.origin);
    match client
        .get(url)
        .bearer_auth(&target.key)
        .timeout(timeout)
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(error) => {
            log::info!("[ConnectionResolver] Local profile probe failed: {error}");
            false
        }
    }
}

/// 同一时刻只跑一个探测；Drop 时释放，覆盖取消与提前返回路径。
struct ProbeInFlight;

impl ProbeInFlight {
    fn acquire() -> Option<Self> {
        (!PROBE_IN_FLIGHT.swap(true, Ordering::AcqRel)).then_some(ProbeInFlight)
    }
}

impl Drop for ProbeInFlight {
    fn drop(&mut self) {
        PROBE_IN_FLIGHT.store(false, Ordering::Release);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FallbackEvent {
    from: ConnectionSource,
    to: ConnectionSource,
}

fn notify_fallback<R: Runtime>(app: &AppHandle<R>) {
    log::warn!("[ConnectionResolver] Local profile unreachable; using server profile");
    let payload = FallbackEvent {
        from: ConnectionSource::Local,
        to: ConnectionSource::Server,
    };
    if let Err(error) = app.emit(FALLBACK_EVENT, payload) {
        log::warn!("[ConnectionResolver] Failed to emit fallback event: {error}");
    }
}

async fn refresh_probe<R: Runtime>(app: &AppHandle<R>, force: bool) -> Result<(), String> {
    let settings = read_settings(app.clone(), app.state::<SettingsState>()).await?;
    let Some(target) = auto_probe_target(&settings) else {
        return Ok(());
    };
    if !force {
        let fresh = {
            let record = read_record();
            !needs_probe(record.as_ref(), &target, Instant::now())
        };
        if fresh {
            return Ok(());
        }
    }
    let Some(_in_flight) = ProbeInFlight::acquire() else {
        return Ok(());
    };
    let reachable = probe_local(client(HttpProfile::AdminApi), &target, PROBE_TIMEOUT).await;
    if commit_probe_result(target, reachable) {
        notify_fallback(app);
    }
    Ok(())
}

/// 启动时登记 AppHandle，供请求出口在无 AppHandle 的上下文中上报失败。
pub fn install(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

/// 请求出口建立连接失败（拒绝 / 超时）时调用。auto 档下若失败地址属于本机档案，
/// 立即标记不可达并强制重探；HTTP 状态错误等非连接类错误不上报。
pub fn report_connect_failure(endpoint_url: &str, error: &reqwest::Error) {
    if !(error.is_connect() || error.is_timeout()) {
        return;
    }
    let (Some(app), Some(failed_origin)) = (APP_HANDLE.get().cloned(), origin_of(endpoint_url))
    else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let Ok(settings) = read_settings(app.clone(), app.state::<SettingsState>()).await else {
            return;
        };
        let Some(target) = auto_probe_target(&settings) else {
            return;
        };
        if target.origin != failed_origin {
            return;
        }
        if commit_probe_result(target, false) {
            notify_fallback(&app);
        }
        if let Err(error) = refresh_probe(&app, true).await {
            log::warn!("[ConnectionResolver] Re-probe after connect failure failed: {error}");
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveVcpConnection {
    vcp_server_url: String,
    vcp_api_key: String,
    source: ConnectionSource,
}

impl From<ResolvedConnection> for EffectiveVcpConnection {
    fn from(resolved: ResolvedConnection) -> Self {
        Self {
            vcp_server_url: resolved.url,
            vcp_api_key: resolved.key,
            source: resolved.source,
        }
    }
}

/// 前端直连请求（语音转写等）取当前生效端点。
#[tauri::command]
pub async fn get_effective_vcp_connection<R: Runtime>(
    app: AppHandle<R>,
    settings_state: State<'_, SettingsState>,
) -> Result<EffectiveVcpConnection, String> {
    let settings = read_settings(app, settings_state).await?;
    Ok(resolve(&settings).into())
}

/// 启动 / 回前台 / 网络变化 / 档案变更时触发；30s 内重复调用命中缓存，不再探测。
#[tauri::command]
pub async fn refresh_connection_probe<R: Runtime>(
    app: AppHandle<R>,
    settings_state: State<'_, SettingsState>,
) -> Result<EffectiveVcpConnection, String> {
    refresh_probe(&app, false).await?;
    let settings = read_settings(app, settings_state).await?;
    Ok(resolve(&settings).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vcp_modules::vcp_client::{freeze_chat_connection, ChatRequestPurpose};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const LEGACY_URL: &str = "https://legacy.example/v1/chat/completions";

    fn settings(extra: Value) -> Settings {
        Settings {
            vcp_server_url: LEGACY_URL.to_string(),
            vcp_api_key: "legacy-key".to_string(),
            extra,
            ..Default::default()
        }
    }

    fn profiles() -> Value {
        json!([
            {"name": "本机", "vcpServerUrl": "http://192.168.1.5:6005/v1/chat/completions", "vcpApiKey": "local-key"},
            {"name": "服务器", "vcpServerUrl": "https://vcp.example.com", "vcpApiKey": "server-key"}
        ])
    }

    fn with_mode(mode: &str) -> Settings {
        settings(json!({"connectionProfileMode": mode, "connectionProfiles": profiles()}))
    }

    fn local_target() -> ProbeTarget {
        ProbeTarget {
            origin: "http://192.168.1.5:6005".to_string(),
            key: "local-key".to_string(),
        }
    }

    fn record(reachable: bool, checked_at: Instant) -> ProbeRecord {
        ProbeRecord {
            target: local_target(),
            reachable,
            checked_at,
        }
    }

    fn legacy() -> ResolvedConnection {
        ResolvedConnection {
            url: LEGACY_URL.to_string(),
            key: "legacy-key".to_string(),
            source: ConnectionSource::Legacy,
        }
    }

    fn local() -> ResolvedConnection {
        ResolvedConnection {
            url: "http://192.168.1.5:6005/v1/chat/completions".to_string(),
            key: "local-key".to_string(),
            source: ConnectionSource::Local,
        }
    }

    fn server() -> ResolvedConnection {
        ResolvedConnection {
            url: "https://vcp.example.com".to_string(),
            key: "server-key".to_string(),
            source: ConnectionSource::Server,
        }
    }

    #[test]
    fn missing_or_invalid_mode_keeps_legacy_fields_verbatim() {
        let unreachable = record(false, Instant::now());
        for extra in [
            Value::Null,
            json!({}),
            json!({"connectionProfiles": profiles()}),
            json!({"connectionProfileMode": null, "connectionProfiles": profiles()}),
            json!({"connectionProfileMode": "bogus", "connectionProfiles": profiles()}),
        ] {
            let s = settings(extra);
            assert_eq!(select_connection(&s, None), legacy());
            assert_eq!(select_connection(&s, Some(&unreachable)), legacy());
            let resolved = resolved_settings(s.clone());
            assert_eq!(resolved.vcp_server_url, s.vcp_server_url);
            assert_eq!(resolved.vcp_api_key, s.vcp_api_key);
        }
        let default = Settings::default();
        let (url, key) = resolve_vcp_connection(&default);
        assert_eq!((url.as_str(), key.as_str()), ("", ""));
    }

    #[test]
    fn explicit_modes_pick_their_profile_and_fall_back_when_missing() {
        assert_eq!(select_connection(&with_mode("local"), None), local());
        assert_eq!(select_connection(&with_mode("server"), None), server());

        let only_local = settings(json!({
            "connectionProfileMode": "server",
            "connectionProfiles": [{"name": "本机", "vcpServerUrl": "http://192.168.1.5:6005", "vcpApiKey": "k"}]
        }));
        assert_eq!(select_connection(&only_local, None), legacy());

        let blank_server = settings(json!({
            "connectionProfileMode": "server",
            "connectionProfiles": [{"name": "服务器", "vcpServerUrl": "   ", "vcpApiKey": "k"}]
        }));
        assert_eq!(select_connection(&blank_server, None), legacy());
    }

    #[test]
    fn auto_uses_local_unless_marked_unreachable_for_the_same_target() {
        let s = with_mode("auto");
        let now = Instant::now();
        assert_eq!(select_connection(&s, None), local());
        assert_eq!(select_connection(&s, Some(&record(true, now))), local());
        assert_eq!(select_connection(&s, Some(&record(false, now))), server());

        let stale_target = ProbeRecord {
            target: ProbeTarget {
                origin: local_target().origin,
                key: "old-key".to_string(),
            },
            reachable: false,
            checked_at: now,
        };
        assert_eq!(select_connection(&s, Some(&stale_target)), local());
    }

    #[test]
    fn auto_probe_target_requires_both_profiles_and_uses_origin() {
        assert!(auto_probe_target(&with_mode("auto")) == Some(local_target()));
        assert!(auto_probe_target(&with_mode("local")).is_none());
        assert!(auto_probe_target(&settings(Value::Null)).is_none());
        let only_local = settings(json!({
            "connectionProfileMode": "auto",
            "connectionProfiles": [{"name": "本机", "vcpServerUrl": "http://192.168.1.5:6005", "vcpApiKey": "k"}]
        }));
        assert!(auto_probe_target(&only_local).is_none());
    }

    #[test]
    fn probe_cache_expires_after_ttl_or_target_change() {
        let at = Instant::now();
        let cached = record(true, at);
        assert!(needs_probe(None, &local_target(), at));
        assert!(!needs_probe(Some(&cached), &local_target(), at + Duration::from_secs(29)));
        assert!(needs_probe(Some(&cached), &local_target(), at + PROBE_CACHE_TTL));
        let other = ProbeTarget {
            origin: "http://10.0.0.2:6005".to_string(),
            key: "local-key".to_string(),
        };
        assert!(needs_probe(Some(&cached), &other, at));
    }

    #[test]
    fn failure_report_switches_to_server_and_notifies_once_per_transition() {
        let s = with_mode("auto");
        let mut slot = None;
        let now = Instant::now();
        assert!(record_probe_result(&mut slot, local_target(), false, now));
        assert_eq!(select_connection(&s, slot.as_ref()), server());
        assert!(!record_probe_result(&mut slot, local_target(), false, now));
        assert!(!record_probe_result(&mut slot, local_target(), true, now));
        assert_eq!(select_connection(&s, slot.as_ref()), local());
        assert!(record_probe_result(&mut slot, local_target(), false, now));
    }

    #[test]
    fn resolved_settings_is_consistent_and_idempotent() {
        let once = resolved_settings(with_mode("server"));
        assert_eq!(once.vcp_server_url, "https://vcp.example.com");
        assert_eq!(once.vcp_api_key, "server-key");
        assert!(once.extra.get(PROFILE_MODE_KEY).is_none());
        assert!(once.extra.get(PROFILES_KEY).is_some());
        let twice = resolved_settings(once.clone());
        assert_eq!(twice.vcp_server_url, once.vcp_server_url);
        assert_eq!(twice.vcp_api_key, once.vcp_api_key);
    }

    #[test]
    fn freeze_chat_connection_follows_profile_and_keeps_legacy() {
        let legacy_snapshot =
            freeze_chat_connection(&settings(Value::Null), ChatRequestPurpose::Interactive).unwrap();
        assert!(legacy_snapshot.endpoint_url.starts_with("https://legacy.example/"));
        assert_eq!(legacy_snapshot.api_key, "legacy-key");

        let server_snapshot =
            freeze_chat_connection(&with_mode("server"), ChatRequestPurpose::Interactive).unwrap();
        assert!(server_snapshot.endpoint_url.starts_with("https://vcp.example.com/"));
        assert_eq!(server_snapshot.api_key, "server-key");
    }

    async fn stub_server(response: Option<&'static str>) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = socket.read(&mut buf).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            match response {
                Some(body) => {
                    let _ = socket.write_all(body.as_bytes()).await;
                }
                None => tokio::time::sleep(Duration::from_secs(5)).await,
            }
            request
        });
        (format!("http://{addr}"), handle)
    }

    fn target_for(origin: String) -> ProbeTarget {
        ProbeTarget {
            origin,
            key: "local-key".to_string(),
        }
    }

    #[tokio::test]
    async fn probe_gets_models_with_bearer_and_accepts_success() {
        let (origin, server) = stub_server(Some(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        ))
        .await;
        let client = Client::new();
        assert!(probe_local(&client, &target_for(origin), Duration::from_secs(2)).await);
        let request = server.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /v1/models "));
        assert!(request.contains("authorization: bearer local-key"));
    }

    #[tokio::test]
    async fn probe_rejects_non_success_status() {
        let (origin, _server) = stub_server(Some(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ))
        .await;
        assert!(!probe_local(&Client::new(), &target_for(origin), Duration::from_secs(2)).await);
    }

    #[tokio::test]
    async fn probe_times_out_on_silent_server() {
        let (origin, server) = stub_server(None).await;
        let started = Instant::now();
        assert!(!probe_local(&Client::new(), &target_for(origin), Duration::from_millis(200)).await);
        assert!(started.elapsed() < Duration::from_secs(2));
        server.abort();
    }

    #[tokio::test]
    async fn probe_fails_fast_on_refused_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        assert!(!probe_local(&Client::new(), &target_for(origin), PROBE_TIMEOUT).await);
    }
}
