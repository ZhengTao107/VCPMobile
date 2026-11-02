use crate::vcp_modules::db_manager::DbWriteMetric;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warning = 3,
    Error = 4,
}

impl LogLevel {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "TRACE" => Some(Self::Trace),
            "DEBUG" => Some(Self::Debug),
            "INFO" => Some(Self::Info),
            "WARN" | "WARNING" => Some(Self::Warning),
            "ERROR" => Some(Self::Error),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warning => "WARN",
            Self::Error => "ERROR",
        }
    }

    fn rust_level(self) -> log::Level {
        match self {
            Self::Trace => log::Level::Trace,
            Self::Debug => log::Level::Debug,
            Self::Info => log::Level::Info,
            Self::Warning => log::Level::Warn,
            Self::Error => log::Level::Error,
        }
    }
}

/// Mirrored session logs kept in the external app directory, including the current session.
const MIRROR_RETAINED_LOGS: usize = 20;
const SYNC_LOG_SUFFIX: &str = "_sync.log";

pub struct SyncLogger {
    log_level: LogLevel,
    log_file: Option<std::fs::File>,
    log_path: Option<PathBuf>,
    mirror: Option<LogMirror>,
    initialization_error: Option<String>,
}

/// Best-effort copy of the session log in a directory that adb can pull without `run-as`.
///
/// Mirror failures are diagnostic loss only: they are warned once and never change the internal
/// log, `initialization_error`, or any sync result.
struct LogMirror {
    file: Option<std::fs::File>,
    path: PathBuf,
    warned: bool,
}

impl LogMirror {
    fn open(dir: &Path, filename: &str) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| {
            format!(
                "Failed to create sync log mirror directory {}: {e}",
                dir.display()
            )
        })?;
        let path = dir.join(filename);
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| {
                format!(
                    "Failed to create sync log mirror file at {}: {e}",
                    path.display()
                )
            })?;
        Ok(Self {
            file: Some(file),
            path,
            warned: false,
        })
    }

    /// Returns a warning the first time mirroring fails; later failures stay silent.
    fn write_line(&mut self, line: &str) -> Option<String> {
        let file = self.file.as_mut()?;
        let result = writeln!(file, "{line}").and_then(|()| file.flush());
        match result {
            Ok(()) => None,
            Err(e) => {
                self.file = None;
                let detail = format!(
                    "Sync log mirror write failed at {}: {e}; mirroring disabled for this session",
                    self.path.display()
                );
                self.warn_once(detail)
            }
        }
    }

    fn warn_once(&mut self, detail: String) -> Option<String> {
        if self.warned {
            return None;
        }
        self.warned = true;
        log::warn!("[SyncLogger] {detail}");
        Some(detail)
    }
}

/// Maps tauri's Android `document_dir()` (`getExternalFilesDir(DIRECTORY_DOCUMENTS)`) to
/// `getExternalFilesDir(null)/logs/sync_logs`. Any other layout yields `None` so the mirror never
/// lands in an unexpected directory.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn android_external_sync_log_dir(document_dir: &Path) -> Option<PathBuf> {
    if document_dir.file_name()? != "Documents" {
        return None;
    }
    let files_dir = document_dir.parent()?;
    if files_dir.file_name()? != "files" {
        return None;
    }
    Some(files_dir.join("logs").join("sync_logs"))
}

/// Newest first; the timestamp-prefixed filename breaks modification-time ties deterministically.
fn select_logs_to_prune(mut logs: Vec<(PathBuf, SystemTime)>, keep: usize) -> Vec<PathBuf> {
    logs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    logs.into_iter().skip(keep).map(|(path, _)| path).collect()
}

/// Deletes all but the newest `keep` regular `*_sync.log` files in the mirror directory.
fn prune_mirror_logs(dir: &Path, keep: usize) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| {
        format!(
            "Failed to list sync log mirror directory {}: {e}",
            dir.display()
        )
    })?;
    let mut logs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_sync_log = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(SYNC_LOG_SUFFIX));
        if !is_sync_log {
            continue;
        }
        // DirEntry::metadata does not follow symlinks, so links are never pruned.
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        logs.push((path, metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
    }

    let failures: Vec<String> = select_logs_to_prune(logs, keep)
        .into_iter()
        .filter_map(|path| {
            fs::remove_file(&path)
                .err()
                .map(|e| format!("{}: {e}", path.display()))
        })
        .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Failed to prune sync log mirror files: {}",
            failures.join("; ")
        ))
    }
}

fn format_log_line(level: LogLevel, phase: &str, message: &str) -> String {
    format!(
        "[{}] [{}] [{}] {}",
        chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
        level.as_str(),
        phase,
        message
    )
}

impl SyncLogger {
    pub fn new_session(log_level: LogLevel, log_dir: Option<PathBuf>, session_id: u64) -> Self {
        Self::new_session_with_mirror(log_level, log_dir, None, session_id)
    }

    /// Like [`Self::new_session`], additionally appending every line to a same-named file in
    /// `mirror_dir` when given. The mirror is best effort and keeps the newest
    /// [`MIRROR_RETAINED_LOGS`] session files.
    pub fn new_session_with_mirror(
        log_level: LogLevel,
        log_dir: Option<PathBuf>,
        mirror_dir: Option<PathBuf>,
        session_id: u64,
    ) -> Self {
        log::info!("[Sync] Session started");

        let filename = format!(
            "{}_{}{}",
            chrono::Local::now().format("%Y%m%d_%H%M%S_%3f"),
            session_id,
            SYNC_LOG_SUFFIX
        );
        let (log_file, log_path, initialization_error) = if let Some(dir) = log_dir {
            match fs::create_dir_all(&dir) {
                Ok(()) => {
                    let path = dir.join(&filename);
                    match OpenOptions::new().create_new(true).write(true).open(&path) {
                        Ok(file) => {
                            log::info!("[SyncLogger] Logging to {:?}", path);
                            (Some(file), Some(path), None)
                        }
                        Err(e) => {
                            let detail = format!(
                                "Failed to create sync log file at {}: {e}",
                                path.display()
                            );
                            log::error!("[SyncLogger] {detail}");
                            (None, None, Some(detail))
                        }
                    }
                }
                Err(e) => {
                    let detail =
                        format!("Failed to create sync log directory {}: {e}", dir.display());
                    log::error!("[SyncLogger] {detail}");
                    (None, None, Some(detail))
                }
            }
        } else {
            let detail = "Application log directory is unavailable".to_string();
            log::error!("[SyncLogger] {detail}");
            (None, None, Some(detail))
        };

        let mut mirror_warning = None;
        let mirror = match mirror_dir {
            Some(dir) => match LogMirror::open(&dir, &filename) {
                Ok(mut mirror) => {
                    log::info!("[SyncLogger] Mirroring to {:?}", mirror.path);
                    if let Err(detail) = prune_mirror_logs(&dir, MIRROR_RETAINED_LOGS) {
                        mirror_warning = mirror.warn_once(detail);
                    }
                    Some(mirror)
                }
                Err(detail) => {
                    log::warn!("[SyncLogger] {detail}");
                    mirror_warning = Some(detail);
                    None
                }
            },
            None => None,
        };

        let mut logger = Self {
            log_level,
            log_file,
            log_path,
            mirror,
            initialization_error,
        };
        logger.log_direct(
            LogLevel::Info,
            "session",
            &format!("Session started (session_id={session_id})"),
        );
        if let Some(detail) = mirror_warning {
            logger.record_line(&format_log_line(LogLevel::Warning, "session", &detail));
        }
        logger
    }

    pub fn log_direct(&mut self, level: LogLevel, phase: &str, message: &str) {
        let line = format_log_line(level, phase, message);
        log::log!(level.rust_level(), "[Sync] [{}] {}", phase, message);
        self.record_line(&line);
    }

    pub fn log(&mut self, level: LogLevel, phase: &str, message: &str) {
        if level < self.log_level {
            return;
        }

        self.log_direct(level, phase, message);
    }

    pub fn log_path(&self) -> Option<&PathBuf> {
        self.log_path.as_ref()
    }

    pub fn initialization_error(&self) -> Option<&str> {
        self.initialization_error.as_deref()
    }

    pub fn end_session(&mut self) {
        log::info!("[Sync] Session ended");
        let line = format!(
            "[{}] [INFO] [sync] Session ended",
            chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z")
        );
        self.record_line(&line);
    }

    /// Writes one formatted line to the internal log, then to the mirror. A first mirror failure
    /// is recorded in the internal log only, so it cannot recurse into the failing mirror.
    fn record_line(&mut self, line: &str) {
        self.write_internal_line(line);
        let warning = self
            .mirror
            .as_mut()
            .and_then(|mirror| mirror.write_line(line));
        if let Some(detail) = warning {
            self.write_internal_line(&format_log_line(LogLevel::Warning, "session", &detail));
        }
    }

    fn write_internal_line(&mut self, line: &str) {
        if let Some(ref mut file) = self.log_file {
            let _ = writeln!(file, "{}", line);
            let _ = file.flush();
        }
    }
}

/// Session-local bridge from the persistence metric bus to the shareable sync log.
///
/// The broadcast receive and synchronous file write happen on this independent task, after the
/// database lease has released its writer guard. Lag or logger failure is diagnostic loss only and
/// can never change a database or sync result.
pub(crate) struct DbWriteMetricLogBridge {
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl DbWriteMetricLogBridge {
    pub(crate) fn start(
        receiver: broadcast::Receiver<DbWriteMetric>,
        logger: Arc<Mutex<SyncLogger>>,
    ) -> Self {
        // The session threshold is immutable. Cache it once so filtered normal metrics do not
        // allocate a formatted line or contend on the logger mutex.
        let minimum_level = logger
            .lock()
            .map(|logger| logger.log_level)
            .unwrap_or(LogLevel::Trace);
        let (stop, stop_rx) = oneshot::channel();
        let task = tokio::spawn(run_db_write_metric_log_bridge(
            receiver,
            logger,
            minimum_level,
            stop_rx,
        ));
        Self {
            stop: Some(stop),
            task,
        }
    }

    pub(crate) async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Err(error) = self.task.await {
            log::warn!("[SyncLogger] DbWrite metric bridge failed: {error}");
        }
    }
}

async fn run_db_write_metric_log_bridge(
    mut receiver: broadcast::Receiver<DbWriteMetric>,
    logger: Arc<Mutex<SyncLogger>>,
    minimum_level: LogLevel,
    mut stop: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => {
                drain_db_write_metrics(&mut receiver, &logger, minimum_level);
                return;
            }
            received = receiver.recv() => {
                match received {
                    Ok(metric) => {
                        if !write_db_write_metric(&logger, minimum_level, metric) {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        if !write_db_write_metric_lag(&logger, skipped) {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    }
}

fn drain_db_write_metrics(
    receiver: &mut broadcast::Receiver<DbWriteMetric>,
    logger: &Arc<Mutex<SyncLogger>>,
    minimum_level: LogLevel,
) {
    // Freeze the session cutoff before draining. A process-wide producer may continue publishing
    // ordinary writes after sync stops; chasing those new metrics could otherwise keep stop_sync
    // alive forever. Lagged entries count against this fixed snapshot because they were part of
    // the observed backlog even though the bounded ring has already overwritten them.
    let mut remaining = receiver.len();
    while remaining > 0 {
        match receiver.try_recv() {
            Ok(metric) => {
                remaining -= 1;
                if !write_db_write_metric(logger, minimum_level, metric) {
                    return;
                }
            }
            Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                let skipped_count = usize::try_from(skipped).unwrap_or(usize::MAX);
                remaining = remaining.saturating_sub(skipped_count);
                if !write_db_write_metric_lag(logger, skipped) {
                    return;
                }
            }
            Err(broadcast::error::TryRecvError::Empty | broadcast::error::TryRecvError::Closed) => {
                return
            }
        }
    }
}

fn write_db_write_metric(
    logger: &Arc<Mutex<SyncLogger>>,
    minimum_level: LogLevel,
    metric: DbWriteMetric,
) -> bool {
    let is_failure = metric.is_failure();
    let is_slow = metric.is_slow();
    let level = if is_failure {
        LogLevel::Error
    } else if is_slow {
        LogLevel::Warning
    } else {
        LogLevel::Debug
    };
    if level < minimum_level {
        return true;
    }
    let message = if is_slow && !is_failure {
        format!("slow {metric}")
    } else {
        metric.to_string()
    };
    write_db_write_log(logger, level, &message)
}

fn write_db_write_metric_lag(logger: &Arc<Mutex<SyncLogger>>, skipped: u64) -> bool {
    write_db_write_log(
        logger,
        LogLevel::Warning,
        &format!("metric stream lagged; skipped={skipped}"),
    )
}

fn write_db_write_log(logger: &Arc<Mutex<SyncLogger>>, level: LogLevel, message: &str) -> bool {
    match logger.lock() {
        Ok(mut logger) => {
            logger.log(level, "db_write", message);
            true
        }
        Err(_) => {
            log::error!("[SyncLogger] DbWrite metric logger lock is poisoned");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_metric(operation: &'static str, outcome: &'static str) -> DbWriteMetric {
        DbWriteMetric {
            operation,
            outcome,
            wait_duration: std::time::Duration::from_millis(12),
            begin_duration: Some(std::time::Duration::from_millis(3)),
            hold_duration: std::time::Duration::from_millis(25),
            finish_duration: Some(std::time::Duration::from_millis(4)),
        }
    }

    #[tokio::test]
    async fn db_write_bridge_shutdown_ignores_metrics_after_its_fixed_cutoff() {
        let temp_dir = tempfile::tempdir().expect("create shutdown metric log directory");
        let logger = Arc::new(Mutex::new(SyncLogger::new_session(
            LogLevel::Error,
            Some(temp_dir.path().to_path_buf()),
            79,
        )));
        let (sender, receiver) = broadcast::channel(8);
        let bridge = DbWriteMetricLogBridge::start(receiver, logger.clone());
        let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let producer_running = running.clone();
        let produced = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let producer_count = produced.clone();
        let producer = std::thread::spawn(move || {
            let metric = test_metric("test.continuous-producer", "committed");
            while producer_running.load(std::sync::atomic::Ordering::Relaxed) {
                if sender.send(metric.clone()).is_ok() {
                    producer_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
        });

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while produced.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("continuous producer never published a metric");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let shutdown =
            tokio::time::timeout(std::time::Duration::from_secs(1), bridge.shutdown()).await;
        running.store(false, std::sync::atomic::Ordering::Relaxed);
        producer.join().expect("join continuous metric producer");

        shutdown.expect("metric bridge chased post-cutoff writes during shutdown");
    }

    fn sync_log_files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("list sync log directory")
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.ends_with(SYNC_LOG_SUFFIX))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn sync_logger_mirror_receives_the_same_lines_under_the_same_name() {
        let internal = tempfile::tempdir().expect("create internal log directory");
        let external = tempfile::tempdir().expect("create mirror root");
        let mirror_dir = external.path().join("logs").join("sync_logs");
        let mut logger = SyncLogger::new_session_with_mirror(
            LogLevel::Info,
            Some(internal.path().to_path_buf()),
            Some(mirror_dir.clone()),
            91,
        );
        logger.log(LogLevel::Info, "phase1", "mirrored line");
        logger.log(LogLevel::Debug, "phase1", "filtered line");
        logger.end_session();

        let log_path = logger.log_path().cloned().expect("internal log path");
        let filename = log_path.file_name().expect("internal log file name");
        let mirror_path = mirror_dir.join(filename);
        let internal_contents = std::fs::read_to_string(&log_path).expect("read internal log");
        let mirror_contents = std::fs::read_to_string(&mirror_path).expect("read mirror log");

        assert_eq!(internal_contents, mirror_contents);
        assert!(mirror_contents.contains("Session started (session_id=91)"));
        assert!(mirror_contents.contains("[INFO] [phase1] mirrored line"));
        assert!(!mirror_contents.contains("filtered line"));
        assert!(mirror_contents.contains("Session ended"));
        assert!(logger.initialization_error().is_none());
    }

    #[test]
    fn sync_logger_unwritable_mirror_keeps_the_internal_log_and_warns_once() {
        let internal = tempfile::tempdir().expect("create internal log directory");
        let external = tempfile::tempdir().expect("create mirror root");
        // A regular file where the mirror directory should be makes create_dir_all fail on every
        // platform without depending on permission bits.
        let blocker = external.path().join("blocker");
        std::fs::write(&blocker, b"not a directory").expect("create mirror blocker file");
        let mut logger = SyncLogger::new_session_with_mirror(
            LogLevel::Info,
            Some(internal.path().to_path_buf()),
            Some(blocker.join("sync_logs")),
            92,
        );
        logger.log(LogLevel::Info, "phase1", "first after failure");
        logger.log(LogLevel::Info, "phase1", "second after failure");
        logger.end_session();

        assert!(logger.initialization_error().is_none());
        let contents = std::fs::read_to_string(logger.log_path().expect("internal log path"))
            .expect("read internal log");
        assert!(contents.contains("Session started (session_id=92)"));
        assert!(contents.contains("first after failure"));
        assert!(contents.contains("second after failure"));
        assert!(contents.contains("Session ended"));
        assert_eq!(contents.matches("sync log mirror").count(), 1);
        assert!(contents.contains("[WARN] [session] Failed to create sync log mirror directory"));
    }

    #[test]
    fn sync_logger_mirror_keeps_only_the_newest_twenty_logs() {
        let internal = tempfile::tempdir().expect("create internal log directory");
        let mirror = tempfile::tempdir().expect("create mirror directory");
        let base = SystemTime::now() - std::time::Duration::from_secs(3600);
        for index in 0..25u64 {
            let path = mirror
                .path()
                .join(format!("20000101_000000_000_{index:02}{SYNC_LOG_SUFFIX}"));
            let file = std::fs::File::create(&path).expect("create old mirror log");
            file.set_modified(base + std::time::Duration::from_secs(index))
                .expect("set old mirror log mtime");
        }
        std::fs::write(mirror.path().join("notes.txt"), b"keep").expect("create unrelated file");

        let logger = SyncLogger::new_session_with_mirror(
            LogLevel::Info,
            Some(internal.path().to_path_buf()),
            Some(mirror.path().to_path_buf()),
            93,
        );

        let current = logger
            .log_path()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .expect("current log name")
            .to_string();
        let remaining = sync_log_files(mirror.path());
        assert_eq!(remaining.len(), MIRROR_RETAINED_LOGS);
        assert!(remaining.contains(&current));
        // The current session plus the 19 most recently modified old logs (indexes 06..=24).
        assert!(!remaining.iter().any(|name| name.contains("_05_sync.log")));
        assert!(remaining.iter().any(|name| name.contains("_06_sync.log")));
        assert!(remaining.iter().any(|name| name.contains("_24_sync.log")));
        assert!(mirror.path().join("notes.txt").exists());
        assert!(logger.initialization_error().is_none());
    }

    #[test]
    fn select_logs_to_prune_orders_by_mtime_then_name() {
        let base = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000);
        let logs = vec![
            (PathBuf::from("a_sync.log"), base),
            (PathBuf::from("c_sync.log"), base),
            (
                PathBuf::from("b_sync.log"),
                base + std::time::Duration::from_secs(1),
            ),
        ];
        assert_eq!(
            select_logs_to_prune(logs.clone(), 2),
            vec![PathBuf::from("a_sync.log")]
        );
        assert!(select_logs_to_prune(logs, 3).is_empty());
    }

    #[test]
    fn android_external_sync_log_dir_maps_documents_to_external_files_logs() {
        let files = PathBuf::from("/storage/emulated/0/Android/data/com.vcp.avatar/files");
        assert_eq!(
            android_external_sync_log_dir(&files.join("Documents")),
            Some(files.join("logs").join("sync_logs"))
        );
        assert_eq!(android_external_sync_log_dir(&files.join("Music")), None);
        assert_eq!(
            android_external_sync_log_dir(Path::new("/data/user/0/com.vcp.avatar/Documents")),
            None
        );
        assert_eq!(android_external_sync_log_dir(Path::new("Documents")), None);
    }
}
