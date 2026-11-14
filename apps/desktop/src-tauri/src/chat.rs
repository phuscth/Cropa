//! The AI chat of one capture: the messages the user and the agent exchanged,
//! kept as `<history>/chats/<id>.json` next to the capture they belong to.
//! [`History`](crate::history::History) owns the reading, writing and deleting
//! so a delete or a prune never races a save; this module owns the file
//! format. The file carries `version` and goes through [`migrate`].
//!
//! The window validates a reply's background against the full schema; here only
//! what can be checked without that schema is checked: shape, lengths and size.
//!
//! Caps: at most [`MAX_MESSAGES`] messages and [`MAX_FILE_BYTES`] bytes per
//! conversation. A save that is over either drops the oldest messages first.
//! With [`KEEP`](crate::history::KEEP) captures in the history, all
//! conversations together stay under about 25 MiB.
//!
//! Message text, thinking and backgrounds are never logged: an error names the
//! field that was refused, never its content.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::settings::AiEffort;

pub const CURRENT_VERSION: u32 = 2;
pub const MAX_MESSAGES: usize = 100;
pub const MAX_FILE_BYTES: usize = 512 * 1024;
const MAX_ID_LEN: usize = 64;
const MAX_USER_TEXT_CHARS: usize = 2000;
const MAX_AGENT_TEXT_BYTES: usize = 16 * 1024;
const MAX_THINKING_BYTES: usize = 16 * 1024;
const MAX_PROVIDER_CHARS: usize = 16;
const MAX_ERROR_CHARS: usize = 32;
const MAX_BACKGROUND_BYTES: usize = 80 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChatRole {
    User,
    Agent,
}

/// What a user message asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChatMode {
    Generate,
    Refine,
    Regenerate,
}

/// How an agent reply ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChatOutcome {
    Applied,
    Failed,
    Cancelled,
}

/// One bubble. The fields after `text` belong to one role: a user message
/// carries `mode`, an agent reply the rest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    /// Milliseconds since the Unix epoch.
    pub at: f64,
    /// What the user typed, or the agent's reply prose.
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ChatMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The model an agent reply ran on; none means the CLI's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<AiEffort>,
    /// The reasoning summary the CLI showed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ChatOutcome>,
    /// A short kind of failure, for example `UsageLimit` or `no-webgl`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The background before the run stayed on the canvas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unchanged: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u32>,
    /// The applied `BackgroundSpec`; the bindings type it as `unknown` and the window validates it.
    #[serde(default)]
    #[specta(type = specta_typescript::Unknown)]
    pub background: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFile {
    pub version: u32,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error("chat file has no numeric `version`")]
    MissingVersion,
    #[error("chat version {0} is newer than this build understands")]
    TooNew(u64),
    #[error("chat file is malformed: {0}")]
    Malformed(#[from] serde_json::Error),
}

impl MigrateError {
    /// A description with no content of the file: a parse error can quote a value from it.
    pub fn kind(&self) -> String {
        match self {
            Self::MissingVersion => "no version".to_owned(),
            Self::TooNew(version) => format!("version {version} is too new"),
            Self::Malformed(err) => format!(
                "{:?} at line {} column {}",
                err.classify(),
                err.line(),
                err.column()
            ),
        }
    }
}

/// Bring any known on-disk version up to [`CURRENT_VERSION`].
pub fn migrate(value: serde_json::Value) -> Result<ChatFile, MigrateError> {
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or(MigrateError::MissingVersion)?;
    match version {
        1 => Ok(serde_json::from_value(v1_to_v2(value))?),
        2 => Ok(serde_json::from_value(value)?),
        other => Err(MigrateError::TooNew(other)),
    }
}

/// Version 2 records the model of a reply. A version 1 reply has none, which
/// reads as the CLI's default: nothing else changes.
fn v1_to_v2(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(file) = value.as_object_mut() {
        file.insert("version".into(), 2.into());
    }
    value
}

#[derive(Debug, thiserror::Error)]
pub enum ChatError {
    /// The name of the field that was refused, never its content.
    #[error("the chat field `{0}` is not valid")]
    Invalid(&'static str),
    #[error("the chat was written by a newer version of Cropa")]
    TooNew,
    #[error("could not read the chat: {0}")]
    Read(String),
    #[error("could not save the chat: {0}")]
    Save(String),
}

fn valid_message_id(id: &str) -> bool {
    (1..=MAX_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Whether `value` is at most `max` characters, and not empty when `required`.
fn chars_within(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.chars().count())
}

/// Refuses a message that is out of shape or over a limit. The error names the field.
pub fn validate(message: &ChatMessage) -> Result<(), ChatError> {
    if !valid_message_id(&message.id) {
        return Err(ChatError::Invalid("id"));
    }
    if !message.at.is_finite() || message.at < 0.0 {
        return Err(ChatError::Invalid("at"));
    }
    match message.role {
        ChatRole::User => {
            if !chars_within(&message.text, 1, MAX_USER_TEXT_CHARS) {
                return Err(ChatError::Invalid("text"));
            }
            if message.mode.is_none() {
                return Err(ChatError::Invalid("mode"));
            }
        }
        ChatRole::Agent => {
            if message.text.len() > MAX_AGENT_TEXT_BYTES {
                return Err(ChatError::Invalid("text"));
            }
            match &message.provider {
                Some(provider) if chars_within(provider, 1, MAX_PROVIDER_CHARS) => {}
                _ => return Err(ChatError::Invalid("provider")),
            }
            if message.outcome.is_none() {
                return Err(ChatError::Invalid("outcome"));
            }
        }
    }
    if message
        .model
        .as_deref()
        .is_some_and(|model| !cropa_agent::valid_model_name(model))
    {
        return Err(ChatError::Invalid("model"));
    }
    if message
        .thinking
        .as_ref()
        .is_some_and(|thinking| thinking.len() > MAX_THINKING_BYTES)
    {
        return Err(ChatError::Invalid("thinking"));
    }
    if message
        .error
        .as_ref()
        .is_some_and(|error| !chars_within(error, 1, MAX_ERROR_CHARS))
    {
        return Err(ChatError::Invalid("error"));
    }
    if let Some(background) = &message.background {
        let size = serde_json::to_vec(background).map_or(usize::MAX, |bytes| bytes.len());
        if size > MAX_BACKGROUND_BYTES {
            return Err(ChatError::Invalid("background"));
        }
    }
    Ok(())
}

/// The file bytes for these messages, after dropping the oldest while there are
/// more than [`MAX_MESSAGES`] or the file would be over [`MAX_FILE_BYTES`].
pub fn encode_capped(mut messages: Vec<ChatMessage>) -> Result<Vec<u8>, ChatError> {
    if messages.len() > MAX_MESSAGES {
        messages.drain(..messages.len() - MAX_MESSAGES);
    }
    loop {
        let file = ChatFile {
            version: CURRENT_VERSION,
            messages,
        };
        let bytes = serde_json::to_vec(&file).map_err(|err| ChatError::Save(err.to_string()))?;
        if bytes.len() <= MAX_FILE_BYTES || file.messages.is_empty() {
            return Ok(bytes);
        }
        messages = file.messages;
        // About a tenth at a time keeps the loop short for a very large set.
        let drop = (messages.len() / 10).max(1);
        messages.drain(..drop);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::json;

    use super::*;

    pub(crate) fn user(id: &str, text: &str) -> ChatMessage {
        ChatMessage {
            id: id.to_owned(),
            role: ChatRole::User,
            at: 1_700_000_000_000.0,
            text: text.to_owned(),
            mode: Some(ChatMode::Generate),
            provider: None,
            model: None,
            effort: None,
            thinking: None,
            outcome: None,
            error: None,
            unchanged: None,
            elapsed_ms: None,
            background: None,
        }
    }

    pub(crate) fn agent(id: &str, text: &str) -> ChatMessage {
        ChatMessage {
            role: ChatRole::Agent,
            mode: None,
            provider: Some("claude".to_owned()),
            model: Some("opus".to_owned()),
            effort: Some(AiEffort::Low),
            outcome: Some(ChatOutcome::Applied),
            elapsed_ms: Some(1200),
            background: Some(json!({"type": "code", "source": "x"})),
            ..user(id, text)
        }
    }

    #[test]
    fn a_version_1_file_reads_as_version_2_and_its_replies_have_no_model() {
        let file = json!({"version": 1, "messages": [
            {"id": "a", "role": "user", "at": 1.0, "text": "hi", "mode": "refine"},
            {"id": "b", "role": "agent", "at": 2.0, "text": "ok", "provider": "codex",
             "effort": "high", "outcome": "applied", "elapsedMs": 900,
             "background": {"type": "code"}}
        ]});
        let read = migrate(file).unwrap();
        assert_eq!(read.version, CURRENT_VERSION);
        assert_eq!(read.messages[0].mode, Some(ChatMode::Refine));
        let reply = &read.messages[1];
        assert_eq!(reply.model, None);
        assert_eq!(reply.provider.as_deref(), Some("codex"));
        assert_eq!(reply.effort, Some(AiEffort::High));
        assert_eq!(reply.outcome, Some(ChatOutcome::Applied));
        assert_eq!(reply.elapsed_ms, Some(900));
        assert_eq!(reply.background, Some(json!({"type": "code"})));
        assert!(validate(reply).is_ok());
    }

    #[test]
    fn a_newer_version_is_refused_and_no_version_is_an_error() {
        let file = json!({"version": 2, "messages": [{"id": "a", "role": "user", "at": 1.0,
            "text": "hi", "mode": "refine"}]});
        let read = migrate(file).unwrap();
        assert_eq!(read.messages[0].mode, Some(ChatMode::Refine));
        assert!(matches!(
            migrate(json!({"version": 3, "messages": []})),
            Err(MigrateError::TooNew(3))
        ));
        assert!(matches!(
            migrate(json!({"messages": []})),
            Err(MigrateError::MissingVersion)
        ));
    }

    #[test]
    fn a_migrate_error_is_described_without_the_content_of_the_file() {
        let file = json!({"version": 1, "messages": [{"id": "a", "role": "SECRET-TEXT"}]});
        let error = migrate(file).unwrap_err();
        assert!(error.to_string().contains("SECRET-TEXT"));
        assert!(!error.kind().contains("SECRET-TEXT"));
    }

    #[test]
    fn a_message_round_trips_through_the_file_format() {
        let messages = vec![user("u1", "make it blue"), agent("a1", "Done")];
        let bytes = encode_capped(messages.clone()).unwrap();
        let file = migrate(serde_json::from_slice(&bytes).unwrap()).unwrap();
        assert_eq!(file.messages, messages);
    }

    #[test]
    fn more_than_a_hundred_messages_keep_the_newest_hundred() {
        let messages: Vec<ChatMessage> = (0..150).map(|n| user(&format!("m{n}"), "x")).collect();
        let bytes = encode_capped(messages).unwrap();
        let file = migrate(serde_json::from_slice(&bytes).unwrap()).unwrap();
        assert_eq!(file.messages.len(), MAX_MESSAGES);
        assert_eq!(file.messages[0].id, "m50");
        assert_eq!(file.messages[99].id, "m149");
    }

    #[test]
    fn a_set_over_the_size_cap_loses_its_oldest_messages() {
        let big = "x".repeat(MAX_AGENT_TEXT_BYTES);
        let messages: Vec<ChatMessage> = (0..60).map(|n| agent(&format!("m{n}"), &big)).collect();
        let bytes = encode_capped(messages).unwrap();
        assert!(bytes.len() <= MAX_FILE_BYTES);
        let file = migrate(serde_json::from_slice(&bytes).unwrap()).unwrap();
        assert!(file.messages.len() < 60);
        assert_eq!(file.messages.last().unwrap().id, "m59");
    }

    #[test]
    fn an_over_long_text_or_a_bad_id_is_refused_by_field() {
        let long = "x".repeat(MAX_USER_TEXT_CHARS + 1);
        assert!(matches!(
            validate(&user("u1", &long)),
            Err(ChatError::Invalid("text"))
        ));
        assert!(matches!(
            validate(&user("../x", "hi")),
            Err(ChatError::Invalid("id"))
        ));
        assert!(matches!(
            validate(&user("", "hi")),
            Err(ChatError::Invalid("id"))
        ));
        let mut huge = agent("a1", "ok");
        huge.background = Some(json!({"source": "x".repeat(MAX_BACKGROUND_BYTES)}));
        assert!(matches!(
            validate(&huge),
            Err(ChatError::Invalid("background"))
        ));
        assert!(validate(&agent("a1", "ok")).is_ok());
        for bad in ["--config", "a b", ""] {
            let mut reply = agent("a1", "ok");
            reply.model = Some(bad.to_owned());
            assert!(matches!(validate(&reply), Err(ChatError::Invalid("model"))));
        }
        let mut default_model = agent("a1", "ok");
        default_model.model = None;
        assert!(validate(&default_model).is_ok());
        // The error names the field, never what was in it.
        let error = validate(&user("u1", &long)).unwrap_err().to_string();
        assert!(!error.contains("xxx"));
    }
}
