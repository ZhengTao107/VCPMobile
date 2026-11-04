//! ptp4g#44：一次性回填 assistant 消息用量（`messages.context_metrics`）。
//! 挑出本地 context_metrics 为空、话题仍存活的 assistant 消息，按话题带具体 msgId 走
//! messages/pull（不发空数组）；写入队列以 metrics_only 只合并用量列，不碰正文与指纹。
//! 全部请求成功后在 settings 写标记，之后不再运行。请求级失败不写标记，下次同步重试；
//! 单话题失败（如电脑端已无该消息）只记日志跳过，避免每次同步都重跑。

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::{Pool, Sqlite};
use tauri::{AppHandle, Manager, Runtime};

use crate::vcp_modules::db_manager::DbState;
use crate::vcp_modules::db_write_queue::DbWriteQueue;
use crate::vcp_modules::sync::sync_transfer::SyncHttpClient;
use crate::vcp_modules::sync_executor::pull_executor::PullExecutor;
use crate::vcp_modules::topic_types::TopicKey;

pub const MARKER_KEY: &str = "ptp4g44.context_metrics_backfill";
const MAX_IDS_PER_REQUEST: usize = 400;
static RUNNING: AtomicBool = AtomicBool::new(false);

pub type PullRequests = Vec<(TopicKey, Vec<String>)>;

pub async fn is_done(pool: &Pool<Sqlite>) -> Result<bool, String> {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?)")
        .bind(MARKER_KEY)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())
}

/// 需要回填的消息，按话题分组；每组 msgId 非空。
pub async fn collect_targets(pool: &Pool<Sqlite>) -> Result<PullRequests, String> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT m.owner_type, m.owner_id, m.topic_id, m.msg_id FROM messages m
         JOIN topics t ON t.owner_type = m.owner_type AND t.owner_id = m.owner_id
          AND t.topic_id = m.topic_id
         WHERE m.role = 'assistant' AND m.deleted_at IS NULL AND m.context_metrics IS NULL
           AND t.deleted_at IS NULL
         ORDER BY m.owner_type, m.owner_id, m.topic_id, m.msg_id",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut grouped: BTreeMap<(String, String, String), Vec<String>> = BTreeMap::new();
    for (owner_type, owner_id, topic_id, msg_id) in rows {
        if msg_id.is_empty() {
            continue;
        }
        grouped
            .entry((owner_type, owner_id, topic_id))
            .or_default()
            .push(msg_id);
    }
    Ok(grouped
        .into_iter()
        .map(|((owner_type, owner_id, topic_id), ids)| {
            (TopicKey::new(owner_type, owner_id, topic_id), ids)
        })
        .filter(|(key, _)| key.is_valid())
        .collect())
}

/// 每个请求的 msgId 总数不超过 max_ids；同一话题在一个请求里只出现一次。
pub fn chunk_requests(targets: PullRequests, max_ids: usize) -> Vec<PullRequests> {
    let max_ids = max_ids.max(1);
    let mut batches = Vec::new();
    let mut current: PullRequests = Vec::new();
    let mut count = 0;
    for (key, ids) in targets {
        for chunk in ids.chunks(max_ids) {
            if !current.is_empty() && count + chunk.len() > max_ids {
                batches.push(std::mem::take(&mut current));
                count = 0;
            }
            current.push((key.clone(), chunk.to_vec()));
            count += chunk.len();
        }
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

async fn mark_done(db: &DbState, total: usize) -> Result<(), String> {
    let mut tx = db
        .write_transaction("sync.context-metrics-backfill")
        .await?;
    sqlx::query("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .bind(MARKER_KEY)
        .bind(total.to_string())
        .bind(crate::vcp_modules::infra::utils::now_millis())
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())
}

/// 已完成返回 None；否则逐批调用 fetch，全部成功后写标记并返回请求的消息数。
pub async fn backfill_with<F, Fut>(db: &DbState, mut fetch: F) -> Result<Option<usize>, String>
where
    F: FnMut(PullRequests) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    if is_done(&db.pool).await? {
        return Ok(None);
    }
    let targets = collect_targets(&db.pool).await?;
    let total = targets.iter().map(|(_, ids)| ids.len()).sum();
    for batch in chunk_requests(targets, MAX_IDS_PER_REQUEST) {
        fetch(batch).await?;
    }
    mark_done(db, total).await?;
    Ok(Some(total))
}

/// 同步收尾成功后由 sync_service 后台调用；并发调用直接跳过。
pub async fn run<R: Runtime>(
    app: &AppHandle<R>,
    client: &SyncHttpClient,
    http_url: &str,
    sync_token: &str,
    write_queue: &DbWriteQueue,
) -> Result<Option<usize>, String> {
    if RUNNING.swap(true, Ordering::AcqRel) {
        return Ok(None);
    }
    let db = app.state::<DbState>();
    let result = backfill_with(&db, |batch| async move {
        let results = PullExecutor::pull_messages_batch(
            app,
            client,
            http_url,
            sync_token,
            &batch,
            write_queue,
            false,
            true,
        )
        .await?;
        for result in results.iter().filter(|result| !result.success) {
            log::warn!(
                "[ContextMetricsBackfill] skipped topic {}: {}",
                result.topic.topic_id,
                result.error.as_deref().unwrap_or("unknown error")
            );
        }
        write_queue.flush().await
    })
    .await;
    RUNNING.store(false, Ordering::Release);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    async fn db() -> DbState {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        for sql in [
            include_str!("../../../migrations/0100_baseline_v2.sql"),
            include_str!("../../../migrations/9001_add_message_context_metrics.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&pool).await.expect("schema");
        }
        sqlx::raw_sql(
            "INSERT INTO topics (topic_id, owner_type, owner_id, title, created_at, updated_at)
             VALUES ('t', 'agent', 'a', 'T', 1, 1), ('gone', 'agent', 'a', 'G', 1, 1);
             UPDATE topics SET deleted_at = 5 WHERE topic_id = 'gone';
             INSERT INTO messages (owner_type, owner_id, topic_id, msg_id, role, content,
                timestamp, created_at, updated_at, deleted_at, context_metrics) VALUES
                ('agent', 'a', 't', 'a1', 'assistant', 'x', 1, 1, 1, NULL, NULL),
                ('agent', 'a', 't', 'a2', 'assistant', 'x', 2, 2, 2, NULL, '{\"rounds\":[]}'),
                ('agent', 'a', 't', 'u1', 'user', 'x', 3, 3, 3, NULL, NULL),
                ('agent', 'a', 't', 'a3', 'assistant', 'x', 4, 4, 4, 9, NULL),
                ('agent', 'a', 'gone', 'a4', 'assistant', 'x', 5, 5, 5, NULL, NULL);",
        )
        .execute(&pool)
        .await
        .expect("seed");
        DbState::new(pool, std::path::PathBuf::new())
    }

    fn ids(batches: &[PullRequests]) -> Vec<Vec<(String, Vec<String>)>> {
        batches
            .iter()
            .map(|batch| {
                batch
                    .iter()
                    .map(|(key, ids)| (key.topic_id.clone(), ids.clone()))
                    .collect()
            })
            .collect()
    }

    #[tokio::test]
    async fn backfill_pulls_exact_ids_once_and_marks_done() {
        let db = db().await;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let result = backfill_with(&db, |batch| {
            let recorder = recorder.clone();
            async move {
                recorder.lock().unwrap().push(batch);
                Ok(())
            }
        })
        .await
        .expect("backfill");
        assert_eq!(result, Some(1));
        assert_eq!(
            ids(&seen.lock().unwrap()),
            vec![vec![("t".to_string(), vec!["a1".to_string()])]]
        );
        assert!(is_done(&db.pool).await.unwrap());

        let again = backfill_with(&db, |_| async {
            Err::<(), String>("must not run twice".into())
        })
        .await
        .expect("second run is a no-op");
        assert_eq!(again, None);
    }

    #[tokio::test]
    async fn failed_request_leaves_marker_unset_for_retry() {
        let db = db().await;
        let failed = backfill_with(&db, |_| async { Err::<(), String>("offline".into()) }).await;
        assert!(failed.is_err());
        assert!(!is_done(&db.pool).await.unwrap());
        let retried = backfill_with(&db, |_| async { Ok(()) })
            .await
            .expect("retry");
        assert_eq!(retried, Some(1));
    }

    #[test]
    fn chunking_caps_ids_and_never_repeats_a_topic_in_one_request() {
        let make = |topic: &str, n: usize| {
            (
                TopicKey::new("agent", "a", topic),
                (0..n).map(|i| format!("{topic}-{i}")).collect::<Vec<_>>(),
            )
        };
        let batches = chunk_requests(vec![make("x", 5), make("y", 1)], 2);
        assert_eq!(
            ids(&batches),
            vec![
                vec![("x".to_string(), vec!["x-0".into(), "x-1".into()])],
                vec![("x".to_string(), vec!["x-2".into(), "x-3".into()])],
                vec![
                    ("x".to_string(), vec!["x-4".into()]),
                    ("y".to_string(), vec!["y-0".into()]),
                ],
            ]
        );
    }
}
