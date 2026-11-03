//! 每条 assistant 消息的上下文用量遥测，口径对齐 VCPChat 桌面端：
//! - 来源：VCP 后端下发的 SSE 块 `{object:"vcp.context.metrics", contextMetrics}`
//!   （请求前一次快照、上游 usage 到达后再推一次同 roundIndex 的更新）。
//! - 存储：`messages.context_metrics`（迁移 9001；ptp4g#31 前为 0101，旧库启动时改号），JSON
//!   `{"rounds":[...], "attachmentTokenEstimate":N}`；前端暴露为
//!   `assistantContextMetricRounds`，字段名与桌面端 history.json 一致。
//! - 元数据不是流所有权：不参与消息指纹、不进同步 DTO、不阻塞 finalize。
//! - 附件估算照搬桌面端 modules/vcpClient.js 的 estimate*Tokens（桌面端未展示此项）。

use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::vcp_modules::db_manager::DbState;
use crate::vcp_modules::topic_types::MessageKey;

pub const METRICS_OBJECT: &str = "vcp.context.metrics";
const MAX_ROUNDS: usize = 64;

/// 解析后的 SSE JSON 若是 metrics 块，返回规范化后的单轮 metrics。
pub fn extract_from_sse_payload(value: &Value) -> Option<Value> {
    if value.get("object").and_then(Value::as_str) != Some(METRICS_OBJECT) {
        return None;
    }
    normalize_round(value.get("contextMetrics")?)
}

/// 与桌面端 mergeAssistantContextMetricRounds 一致：totalContextTokens 必须为正，
/// roundIndex 取非负整数（缺失为 0）。
pub fn normalize_round(metrics: &Value) -> Option<Value> {
    let object = metrics.as_object()?;
    let total = object
        .get("totalContextTokens")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)?;
    let round_index = object
        .get("roundIndex")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.floor() as u64)
        .unwrap_or(0);
    let mut normalized = object.clone();
    normalized.insert("totalContextTokens".into(), json!(total));
    normalized.insert("roundIndex".into(), json!(round_index));
    Some(Value::Object(normalized))
}

/// 按 roundIndex 合并，后到的同轮覆盖先到的（usage 更新覆盖请求前快照）。
#[derive(Debug, Default, Clone)]
pub struct RoundCollector {
    rounds: BTreeMap<u64, Value>,
}

impl RoundCollector {
    pub fn record(&mut self, round: Value) {
        let index = round["roundIndex"].as_u64().unwrap_or(0);
        if !self.rounds.contains_key(&index) && self.rounds.len() >= MAX_ROUNDS {
            return;
        }
        self.rounds.insert(index, round);
    }

    pub fn extend(&mut self, rounds: impl IntoIterator<Item = Value>) {
        for round in rounds {
            if let Some(round) = normalize_round(&round) {
                self.record(round);
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.rounds.is_empty()
    }

    pub fn latest(&self) -> Option<&Value> {
        self.rounds.values().next_back()
    }

    pub fn to_vec(&self) -> Vec<Value> {
        self.rounds.values().cloned().collect()
    }
}

fn base64_byte_length(data: &str) -> u64 {
    let payload = match data.find(',') {
        Some(index) => &data[index + 1..],
        None => data,
    };
    let compact: Vec<u8> = payload
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    let padding = compact
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count() as u64;
    ((compact.len() as u64 * 3) / 4).saturating_sub(padding)
}

fn first_str<'a>(part: &'a Value, paths: &[&[&str]]) -> &'a str {
    for path in paths {
        let mut cursor = part;
        let mut found = true;
        for key in *path {
            match cursor.get(*key) {
                Some(next) => cursor = next,
                None => {
                    found = false;
                    break;
                }
            }
        }
        if found {
            if let Some(text) = cursor.as_str() {
                return text;
            }
        }
    }
    ""
}

fn size_estimate(bytes: u64, per_kb: u64) -> u64 {
    if bytes == 0 {
        0
    } else {
        ((bytes * per_kb + 1023) / 1024).max(1)
    }
}

/// 单个非文本 content part 的估算，逐条照搬桌面端 vcpClient.js。
pub fn estimate_part_tokens(part: &Value) -> u64 {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => 0,
        Some("image_url") => {
            let detail = first_str(part, &[&["image_url", "detail"], &["detail"]]);
            if detail.eq_ignore_ascii_case("low") {
                85
            } else {
                765
            }
        }
        Some("input_audio") | Some("audio") => size_estimate(
            base64_byte_length(first_str(
                part,
                &[&["input_audio", "data"], &["audio", "data"], &["data"]],
            )),
            32,
        ),
        Some("file") => size_estimate(
            base64_byte_length(first_str(
                part,
                &[&["file", "file_data"], &["file", "data"], &["data"]],
            )),
            8,
        ),
        _ => {
            if !part.is_object() {
                return 0;
            }
            // JSON.stringify(part).length / 12，向上取整，至少 1。
            let length = serde_json::to_string(part)
                .map(|text| text.encode_utf16().count() as u64)
                .unwrap_or(0);
            ((length + 11) / 12).max(1)
        }
    }
}

/// 实际发往 VCP 的 messages 中全部附件 part 的估算总和（与"总计"同为上下文口径）。
pub fn estimate_attachment_tokens(messages: &Value) -> u64 {
    messages
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|message| message.get("content").and_then(Value::as_array))
        .flatten()
        .map(estimate_part_tokens)
        .sum()
}

pub fn encode_payload(rounds: &[Value], attachment_tokens: u64) -> Value {
    json!({ "rounds": rounds, "attachmentTokenEstimate": attachment_tokens })
}

/// 流结束、finalize 之前写入（pending 行已存在）；只改 context_metrics 列，
/// 不碰正文/指纹/finish_reason。无数据时不触碰数据库。
pub async fn persist(
    db: &DbState,
    key: &MessageKey,
    rounds: &[Value],
    attachment_tokens: u64,
) -> Result<(), String> {
    if rounds.is_empty() && attachment_tokens == 0 {
        return Ok(());
    }
    let mut tx = db.write_transaction("message.context_metrics").await?;
    let existing: Option<Option<String>> = sqlx::query_scalar(
        "SELECT context_metrics FROM messages
         WHERE owner_type = ? AND owner_id = ? AND topic_id = ? AND msg_id = ?
           AND deleted_at IS NULL",
    )
    .bind(&key.topic.owner_type)
    .bind(&key.topic.owner_id)
    .bind(&key.topic.topic_id)
    .bind(&key.msg_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    let Some(existing) = existing else {
        return Ok(());
    };
    let mut collector = RoundCollector::default();
    let mut attachment_tokens = attachment_tokens;
    if let Some(raw) = existing {
        if let Ok(previous) = serde_json::from_str::<Value>(&raw) {
            collector.extend(previous["rounds"].as_array().cloned().unwrap_or_default());
            // resume 不重发请求体，估算为 0；保留首次请求时的估算。
            if attachment_tokens == 0 {
                attachment_tokens = previous["attachmentTokenEstimate"].as_u64().unwrap_or(0);
            }
        }
    }
    collector.extend(rounds.iter().cloned());
    let payload = encode_payload(&collector.to_vec(), attachment_tokens).to_string();
    sqlx::query(
        "UPDATE messages SET context_metrics = ?
         WHERE owner_type = ? AND owner_id = ? AND topic_id = ? AND msg_id = ?
           AND deleted_at IS NULL",
    )
    .bind(payload)
    .bind(&key.topic.owner_type)
    .bind(&key.topic.owner_id)
    .bind(&key.topic.topic_id)
    .bind(&key.msg_id)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    tx.commit().await
}

/// 读取一个话题内所有带遥测的消息：msgId -> payload。
pub async fn load_topic(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    owner_type: &str,
    owner_id: &str,
    topic_id: &str,
) -> Result<serde_json::Map<String, Value>, String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT msg_id, context_metrics FROM messages
         WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
           AND deleted_at IS NULL AND context_metrics IS NOT NULL",
    )
    .bind(owner_type)
    .bind(owner_id)
    .bind(topic_id)
    .fetch_all(pool)
    .await
    .map_err(|error| error.to_string())?;
    let mut result = serde_json::Map::new();
    for (msg_id, raw) in rows {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            result.insert(msg_id, value);
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn get_topic_context_metrics(
    app_handle: tauri::AppHandle,
    owner_id: String,
    owner_type: String,
    topic_id: String,
) -> Result<serde_json::Map<String, Value>, String> {
    use tauri::Manager;
    let db_state = app_handle.state::<DbState>();
    load_topic(&db_state.pool, &owner_type, &owner_id, &topic_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vcp_modules::topic_types::TopicKey;

    #[test]
    fn sse_metrics_block_is_recognised_and_normalised() {
        let chunk = json!({
            "object": "vcp.context.metrics",
            "messageId": "m",
            "contextMetrics": {"totalContextTokens": 1200, "roundIndex": 1.7,
                "upstreamUsage": {"cachedTokens": 900, "cacheReported": true}}
        });
        let round = extract_from_sse_payload(&chunk).expect("metrics");
        assert_eq!(round["roundIndex"], 1);
        assert_eq!(round["upstreamUsage"]["cachedTokens"], 900);
        assert!(extract_from_sse_payload(&json!({"choices": []})).is_none());
        assert!(extract_from_sse_payload(&json!({
            "object": "vcp.context.metrics", "contextMetrics": {"totalContextTokens": 0}
        }))
        .is_none());
    }

    #[test]
    fn later_round_update_replaces_snapshot_with_same_index() {
        let mut collector = RoundCollector::default();
        collector.extend([
            json!({"totalContextTokens": 100, "roundIndex": 0}),
            json!({"totalContextTokens": 300, "roundIndex": 1}),
            json!({"totalContextTokens": 110, "roundIndex": 0,
                   "upstreamUsage": {"cachedTokens": 50}}),
        ]);
        let rounds = collector.to_vec();
        assert_eq!(rounds.len(), 2);
        assert_eq!(rounds[0]["totalContextTokens"], 110.0);
        assert_eq!(rounds[0]["upstreamUsage"]["cachedTokens"], 50);
        assert_eq!(collector.latest().unwrap()["roundIndex"], 1);
        assert!(!collector.is_empty());
    }

    #[test]
    fn attachment_estimate_matches_desktop_vcp_client() {
        // 4 字节音频 -> ceil(4/1024*32)=1；3072 字节文件 -> ceil(3*8)=24
        let audio = "data:audio/wav;base64,AAAAAA==";
        let file = format!("data:application/pdf;base64,{}", "A".repeat(4096));
        let messages = json!([
            {"role": "user", "content": "plain"},
            {"role": "user", "content": [
                {"type": "text", "text": "hi"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}},
                {"type": "image_url", "image_url": {"url": "x", "detail": "LOW"}},
                {"type": "input_audio", "input_audio": {"data": audio}},
                {"type": "file", "file": {"file_data": file}},
                {"type": "custom", "x": 1}
            ]}
        ]);
        let generic = (r#"{"type":"custom","x":1}"#.len() as u64 + 11) / 12;
        assert_eq!(base64_byte_length(audio), 4);
        assert_eq!(
            estimate_attachment_tokens(&messages),
            765 + 85 + 1 + 24 + generic
        );
        assert_eq!(estimate_attachment_tokens(&json!("not-array")), 0);
    }

    async fn db() -> DbState {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::raw_sql(include_str!("../../../migrations/0100_baseline_v2.sql"))
            .execute(&pool)
            .await
            .expect("baseline");
        sqlx::raw_sql(include_str!(
            "../../../migrations/9001_add_message_context_metrics.sql"
        ))
        .execute(&pool)
        .await
        .expect("9001");
        sqlx::query(
            "INSERT INTO messages (owner_type, owner_id, topic_id, msg_id, role, content,
                timestamp, created_at, updated_at)
             VALUES ('agent', 'a', 't', 'm', 'assistant', 'x', 1, 1, 1)",
        )
        .execute(&pool)
        .await
        .expect("message");
        DbState::new(pool, std::path::PathBuf::new())
    }

    #[tokio::test]
    async fn persist_merges_rounds_and_load_returns_them_without_touching_hash() {
        let db = db().await;
        let key = MessageKey::new(TopicKey::new("agent", "a", "t"), "m");
        persist(
            &db,
            &key,
            &[json!({"totalContextTokens": 10, "roundIndex": 0})],
            765,
        )
        .await
        .expect("first");
        persist(
            &db,
            &key,
            &[json!({"totalContextTokens": 20, "roundIndex": 1})],
            765,
        )
        .await
        .expect("second");
        persist(&db, &key, &[], 0).await.expect("noop");
        persist(
            &db,
            &key,
            &[json!({"totalContextTokens": 21, "roundIndex": 1})],
            0,
        )
        .await
        .expect("resume keeps estimate");
        let missing = MessageKey::new(TopicKey::new("agent", "a", "t"), "absent");
        persist(&db, &missing, &[json!({"totalContextTokens": 5})], 0)
            .await
            .expect("missing row is a no-op");
        let topic = load_topic(&db.pool, "agent", "a", "t").await.expect("load");
        assert_eq!(topic.len(), 1);
        assert_eq!(topic["m"]["rounds"].as_array().unwrap().len(), 2);
        assert_eq!(topic["m"]["attachmentTokenEstimate"], 765);
        let hash: String = sqlx::query_scalar("SELECT content_hash FROM messages")
            .fetch_one(&db.pool)
            .await
            .expect("hash");
        assert_eq!(hash, "");
    }
}
