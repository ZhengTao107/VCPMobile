use crate::vcp_modules::agent_types::AgentConfig;
use crate::vcp_modules::group_types::{deserialize_member_tags, GroupConfig, MemberTags};
use serde::{Deserialize, Serialize};

fn deserialize_required_sha256<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.len() == 64
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value.bytes().all(|byte| !byte.is_ascii_uppercase())
    {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(
            "expected a lowercase 64-character SHA-256",
        ))
    }
}

fn deserialize_sync_updated_at<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = i64::deserialize(deserializer)?;
    if (0..=(1_i64 << 53) - 1).contains(&value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom(
            "expected a non-negative safe integer updatedAt",
        ))
    }
}

/// createdAt 只用于排序展示；桌面端历史数据可能给出 null（ISO 字符串经 CDS 转换失败），按 0 处理，避免整批 untagged 反序列化失败。
fn deserialize_nullable_created_at<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<i64>::deserialize(deserializer)?.unwrap_or(0))
}
/// =================================================================
/// vcp_modules/sync_dto.rs - 双端同步标准契约 (The Shared Truth)
/// =================================================================
/// 智能体同步数据传输对象
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSyncDTO {
    pub name: String,
    pub system_prompt: String,
    pub model: String,
    pub temperature: f64,
    pub context_token_limit: i32,
    pub max_output_tokens: i32,
    pub stream_output: bool,
}

impl From<&AgentConfig> for AgentSyncDTO {
    fn from(config: &AgentConfig) -> Self {
        Self {
            name: config.name.clone(),
            system_prompt: config.system_prompt.clone(),
            model: config.model.clone(),
            temperature: config.temperature,
            context_token_limit: config.context_token_limit,
            max_output_tokens: config.max_output_tokens,
            stream_output: config.stream_output,
        }
    }
}

/// 群组同步数据传输对象
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupSyncDTO {
    pub name: String,
    pub members: Vec<String>,
    pub mode: String,
    #[serde(
        default,
        deserialize_with = "deserialize_member_tags",
        skip_serializing_if = "Option::is_none"
    )]
    pub member_tags: Option<MemberTags>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_prompt: Option<String>,
    pub use_unified_model: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unified_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_match_mode: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_created_at")]
    pub created_at: i64,
}

impl From<&GroupConfig> for GroupSyncDTO {
    fn from(config: &GroupConfig) -> Self {
        Self {
            name: config.name.clone(),
            members: config.members.clone(),
            mode: config.mode.clone(),
            member_tags: config.member_tags.clone(),
            group_prompt: config.group_prompt.clone(),
            invite_prompt: config.invite_prompt.clone(),
            use_unified_model: config.use_unified_model,
            unified_model: config.unified_model.clone(),
            tag_match_mode: config.tag_match_mode.clone(),
            created_at: config.created_at,
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Agent Topic 同步 DTO (包含 locked/unread)
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTopicSyncDTO {
    pub id: String,
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_nullable_created_at")]
    pub created_at: i64,
    pub locked: bool,
    pub unread: bool,
    /// ptp4g#44：电脑只在 true 时发送；缺省=未置顶。false 不序列化，未置顶话题线格式与哈希不变。
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    pub owner_id: String,
    #[serde(
        rename = "configHash",
        deserialize_with = "deserialize_required_sha256"
    )]
    pub config_hash: String,
    #[serde(rename = "updatedAt", deserialize_with = "deserialize_sync_updated_at")]
    pub updated_at: i64,
}

/// Group Topic 同步 DTO (无 locked/unread)
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupTopicSyncDTO {
    pub id: String,
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_nullable_created_at")]
    pub created_at: i64,
    /// ptp4g#44：与 AgentTopicSyncDTO 同语义，电脑只在 true 时发送；缺省=未置顶，false 不序列化。
    #[serde(default, skip_serializing_if = "is_false")]
    pub pinned: bool,
    pub owner_id: String,
    #[serde(
        rename = "configHash",
        deserialize_with = "deserialize_required_sha256"
    )]
    pub config_hash: String,
    #[serde(rename = "updatedAt", deserialize_with = "deserialize_sync_updated_at")]
    pub updated_at: i64,
}

/// 附件同步 DTO
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSyncDTO {
    pub r#type: String,
    pub name: String,
    pub size: u64,
    pub hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_frames: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
}

/// 消息持久同步 DTO：Push/Pull 共用同一份 canonical 契约。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessageSyncDTO {
    pub id: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub content: String,
    pub timestamp: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(rename = "agentId", default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(rename = "groupId", default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(rename = "topicId", default, skip_serializing_if = "Option::is_none")]
    pub topic_id: Option<String>,
    #[serde(
        rename = "isGroupMessage",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub is_group_message: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AttachmentSyncDTO>>,
    #[serde(
        rename = "contentHash",
        deserialize_with = "deserialize_required_sha256"
    )]
    pub content_hash: String,
    /// ptp4g#44：电脑原样透传的用量轮次（纯 round 数组）。只收不发、不进消息指纹；
    /// 用 Value 接收，非数组时只丢弃用量，不拒收整条消息。
    #[serde(rename = "assistantContextMetricRounds", default, skip_serializing)]
    pub assistant_context_metric_rounds: Option<serde_json::Value>,
}

impl From<MessageSyncDTO> for crate::vcp_modules::chat_manager::ChatMessage {
    fn from(dto: MessageSyncDTO) -> Self {
        Self {
            id: dto.id,
            role: dto.role,
            name: dto.name,
            content: dto.content,
            timestamp: dto.timestamp,
            updated_at: Some(dto.updated_at),
            is_thinking: None,
            agent_id: dto.agent_id,
            group_id: dto.group_id,
            topic_id: dto.topic_id,
            is_group_message: dto.is_group_message,
            finish_reason: dto.finish_reason,
            attachments: dto.attachments.map(|atts| {
                atts.into_iter()
                    .map(|a| crate::vcp_modules::chat_manager::Attachment {
                        r#type: a.r#type,
                        src: "".to_string(), // 在下游的 process_topic_messages 里会被 path_map 自动填充
                        name: a.name,
                        size: a.size,
                        hash: Some(a.hash),
                        status: None,
                        attachment_order: None,
                        internal_path: "".to_string(),
                        extracted_text: a.extracted_text,
                        image_frames: a.image_frames,
                        thumbnail_path: None,
                        created_at: a.created_at,
                    })
                    .collect()
            }),
            // blocks/render_cache 是本地状态；下游依设置可选预渲染，否则由加载路径懒生成。
            blocks: None,
            content_hash: Some(dto.content_hash),
            shell: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_topic_sync_dto_tolerates_null_or_missing_created_at() {
        let base = |created_at: Option<serde_json::Value>| {
            let mut value = json!({
                "id": "topic-1",
                "name": "Topic",
                "locked": false,
                "unread": false,
                "ownerId": "agent-1",
                "configHash": "a".repeat(64),
                "updatedAt": 456
            });
            if let Some(created_at) = created_at {
                value["createdAt"] = created_at;
            }
            value
        };
        let null_dto: AgentTopicSyncDTO =
            serde_json::from_value(base(Some(serde_json::Value::Null))).expect("null createdAt");
        assert_eq!(null_dto.created_at, 0);
        let missing_dto: AgentTopicSyncDTO =
            serde_json::from_value(base(None)).expect("missing createdAt");
        assert_eq!(missing_dto.created_at, 0);
        let ok_dto: AgentTopicSyncDTO =
            serde_json::from_value(base(Some(json!(123)))).expect("numeric createdAt");
        assert_eq!(ok_dto.created_at, 123);
        assert_eq!(
            serde_json::to_value(&ok_dto).unwrap()["createdAt"],
            json!(123)
        );
        assert!(
            serde_json::from_value::<AgentTopicSyncDTO>(base(Some(json!("2026-11-01")))).is_err()
        );
    }

    /// ptp4g#44：pinned 缺省=未置顶且不序列化；true 原样往返；未知字段仍被拒收。
    #[test]
    fn agent_topic_sync_dto_pinned_round_trip() {
        let mut value = json!({
            "id": "topic-1",
            "name": "Topic",
            "createdAt": 1,
            "locked": false,
            "unread": false,
            "ownerId": "agent-1",
            "configHash": "a".repeat(64),
            "updatedAt": 456
        });
        let legacy: AgentTopicSyncDTO =
            serde_json::from_value(value.clone()).expect("legacy DTO without pinned");
        assert!(!legacy.pinned);
        assert!(serde_json::to_value(&legacy)
            .unwrap()
            .get("pinned")
            .is_none());

        value["pinned"] = json!(true);
        let pinned: AgentTopicSyncDTO = serde_json::from_value(value.clone()).expect("pinned DTO");
        assert!(pinned.pinned);
        assert_eq!(
            serde_json::to_value(&pinned).unwrap()["pinned"],
            json!(true)
        );

        value["pinned"] = json!(false);
        let unpinned: AgentTopicSyncDTO =
            serde_json::from_value(value.clone()).expect("explicit false");
        assert!(!unpinned.pinned);
        assert!(serde_json::to_value(&unpinned)
            .unwrap()
            .get("pinned")
            .is_none());

        value["bogus"] = json!(1);
        assert!(serde_json::from_value::<AgentTopicSyncDTO>(value).is_err());
    }
}
