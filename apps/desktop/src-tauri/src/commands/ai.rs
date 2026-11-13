//! Runs one AI turn through a CLI adapter, streams its progress to the window
//! and cancels it on request. The window never starts a process: `ai_run`
//! hands a validated request to a `cropa_agent::AgentCli` in Rust.
//!
//! Logs hold the run id, provider, timing and outcome kind, never the prompt,
//! the schema, the images or the model output.

// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine;
use cropa_agent::{
    AgentCli, AgentError, CancelToken, Detection, Event, Mock, MockScript, RunOutput, RunRequest,
    TurnDir,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use super::png_data_url;

const MAX_RUN_ID_CHARS: usize = 64;
const MAX_MODEL_CHARS: usize = 64;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_IMAGES: usize = 4;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const DEFAULT_TIMEOUT_MS: u32 = 60_000;
const MIN_TIMEOUT_MS: u32 = 5_000;
const MAX_TIMEOUT_MS: u32 = 300_000;

/// The runs in flight, by the id the window chose.
#[derive(Default)]
pub struct AiRuns(Mutex<HashMap<String, CancelToken>>);

impl AiRuns {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancelToken>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Removes a run from [`AiRuns`] when it ends, however it ends.
struct RunGuard {
    app: AppHandle,
    run_id: String,
}

impl RunGuard {
    fn register(app: &AppHandle, run_id: &str, token: CancelToken) -> Result<Self, AiError> {
        let runs = app.state::<AiRuns>();
        let mut runs = runs.lock();
        if runs.contains_key(run_id) {
            return Err(AiError::RunIdInUse);
        }
        runs.insert(run_id.to_owned(), token);
        Ok(Self {
            app: app.clone(),
            run_id: run_id.to_owned(),
        })
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.app.state::<AiRuns>().lock().remove(&self.run_id);
    }
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub system: String,
    pub prompt: String,
    /// JSON schema the reply must follow.
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub schema: Option<serde_json::Value>,
    /// Input pictures as base64 PNG, with no `data:` prefix.
    pub images: Vec<String>,
    pub want_image: bool,
    pub model: Option<String>,
    pub timeout_ms: Option<u32>,
}

/// Progress of a run, sent over the channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    Started,
    Delta { text: String },
}

/// Why a mock run fails.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiErrorKind {
    NotInstalled,
    NotLoggedIn,
    UsageLimit,
    Unsupported,
    Timeout,
    Protocol,
    Cancelled,
}

/// What the mock provider does. Only the mock reads it.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiMockScript {
    pub delay_ms: u32,
    pub events: Vec<AiEvent>,
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub result: Option<serde_json::Value>,
    pub error: Option<AiErrorKind>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiOutput {
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub json: Option<serde_json::Value>,
    /// A PNG data URL.
    pub image: Option<String>,
}

/// Error returned to the WebView. The UI turns `kind` into a translated
/// message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Type)]
#[serde(tag = "kind", content = "detail")]
pub enum AiError {
    #[error("the CLI is not installed")]
    NotInstalled,
    #[error("the CLI is not logged in")]
    NotLoggedIn,
    #[error("the CLI reached its usage limit")]
    UsageLimit,
    #[error("this provider cannot do that")]
    Unsupported,
    #[error("the CLI took too long")]
    Timeout,
    #[error("unexpected CLI behaviour: {0}")]
    Protocol(String),
    #[error("the run was cancelled")]
    Cancelled,
    #[error("the request is not valid: {0}")]
    InvalidRequest(String),
    #[error("a run with that id is already in progress")]
    RunIdInUse,
}

impl From<AgentError> for AiError {
    fn from(err: AgentError) -> Self {
        match err {
            AgentError::NotInstalled => Self::NotInstalled,
            AgentError::NotLoggedIn => Self::NotLoggedIn,
            AgentError::UsageLimit => Self::UsageLimit,
            AgentError::Unsupported => Self::Unsupported,
            AgentError::Timeout => Self::Timeout,
            AgentError::Protocol(text) => Self::Protocol(text),
            AgentError::Cancelled => Self::Cancelled,
        }
    }
}

impl AiError {
    /// A short name for the log.
    fn name(&self) -> &'static str {
        match self {
            Self::NotInstalled => "not-installed",
            Self::NotLoggedIn => "not-logged-in",
            Self::UsageLimit => "usage-limit",
            Self::Unsupported => "unsupported",
            Self::Timeout => "timeout",
            Self::Protocol(_) => "protocol",
            Self::Cancelled => "cancelled",
            Self::InvalidRequest(_) => "invalid-request",
            Self::RunIdInUse => "run-id-in-use",
        }
    }
}

impl From<AiErrorKind> for AgentError {
    fn from(kind: AiErrorKind) -> Self {
        match kind {
            AiErrorKind::NotInstalled => Self::NotInstalled,
            AiErrorKind::NotLoggedIn => Self::NotLoggedIn,
            AiErrorKind::UsageLimit => Self::UsageLimit,
            AiErrorKind::Unsupported => Self::Unsupported,
            AiErrorKind::Timeout => Self::Timeout,
            AiErrorKind::Protocol => Self::Protocol("scripted failure".to_owned()),
            AiErrorKind::Cancelled => Self::Cancelled,
        }
    }
}

/// What a provider can do here. `available` is false while Cropa has no
/// adapter for it; the other fields are then unknown.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiDetection {
    pub provider: String,
    pub available: bool,
    pub installed: Option<bool>,
    pub version: Option<String>,
    pub logged_in: Option<bool>,
    pub image_in: bool,
    pub image_out: bool,
}

impl AiDetection {
    fn unavailable(provider: &str) -> Self {
        Self {
            provider: provider.to_owned(),
            available: false,
            installed: None,
            version: None,
            logged_in: None,
            image_in: false,
            image_out: false,
        }
    }

    #[cfg(debug_assertions)]
    fn from_mock(detection: Detection) -> Self {
        Self {
            provider: "mock".to_owned(),
            available: true,
            installed: Some(true),
            version: detection.version,
            logged_in: detection.logged_in,
            image_in: detection.image_in,
            image_out: detection.image_out,
        }
    }
}

fn invalid(what: &str) -> AiError {
    AiError::InvalidRequest(what.to_owned())
}

fn validate_run_id(run_id: &str) -> Result<(), AiError> {
    let ok = (1..=MAX_RUN_ID_CHARS).contains(&run_id.len())
        && run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok { Ok(()) } else { Err(invalid("run id")) }
}

fn validate_model(model: Option<&str>) -> Result<(), AiError> {
    let Some(model) = model else { return Ok(()) };
    let ok = (1..=MAX_MODEL_CHARS).contains(&model.len())
        && !model.starts_with('-')
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
    if ok { Ok(()) } else { Err(invalid("model")) }
}

fn validate_text(request: &AiRequest) -> Result<(), AiError> {
    if request.system.len() + request.prompt.len() > MAX_TEXT_BYTES {
        return Err(invalid("prompt too large"));
    }
    if let Some(schema) = &request.schema
        && schema.to_string().len() > MAX_TEXT_BYTES
    {
        return Err(invalid("schema too large"));
    }
    Ok(())
}

/// Decodes the input pictures and checks each is a PNG within the size limit.
fn decode_images(images: &[String]) -> Result<Vec<Vec<u8>>, AiError> {
    if images.len() > MAX_IMAGES {
        return Err(invalid("too many images"));
    }
    images
        .iter()
        .map(|encoded| {
            // Reject before decoding what could not fit once decoded.
            if encoded.len() > MAX_IMAGE_BYTES / 3 * 4 + 4 {
                return Err(invalid("image too large"));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| invalid("image is not base64"))?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(invalid("image too large"));
            }
            if !bytes.starts_with(PNG_SIGNATURE) {
                return Err(invalid("image is not a PNG"));
            }
            Ok(bytes)
        })
        .collect()
}

/// The timeout asked for, kept between 5 and 300 seconds; 60 by default.
fn clamp_timeout(timeout_ms: Option<u32>) -> Duration {
    let ms = timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    Duration::from_millis(u64::from(ms))
}

/// The adapter for a provider name, or `None` while there is none. The real
/// Codex and Claude Code adapters are added here.
#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn provider_for(name: &str, mock: Option<AiMockScript>) -> Option<Box<dyn AgentCli>> {
    #[cfg(debug_assertions)]
    if name == "mock" {
        return Some(Box::new(Mock::new(mock_script(mock))));
    }
    None
}

#[cfg(debug_assertions)]
fn mock_script(script: Option<AiMockScript>) -> MockScript {
    let script = script.unwrap_or_else(|| AiMockScript {
        delay_ms: 1500,
        events: vec![
            AiEvent::Delta {
                text: "one".to_owned(),
            },
            AiEvent::Delta {
                text: "two".to_owned(),
            },
            AiEvent::Delta {
                text: "three".to_owned(),
            },
        ],
        result: None,
        error: None,
    });
    MockScript {
        delay: Duration::from_millis(u64::from(script.delay_ms)),
        events: script
            .events
            .into_iter()
            .map(|event| match event {
                AiEvent::Started => Event::Started,
                AiEvent::Delta { text } => Event::Delta { text },
            })
            .collect(),
        outcome: match script.error {
            Some(kind) => Err(kind.into()),
            None => Ok(script.result.unwrap_or_else(|| serde_json::json!({}))),
        },
    }
}

fn to_ai_event(event: Event) -> Option<AiEvent> {
    match event {
        Event::Started => Some(AiEvent::Started),
        Event::Delta { text } => Some(AiEvent::Delta { text }),
        // A newer kind of event the window does not know yet.
        _ => None,
    }
}

/// Writes the input pictures into `dir` and returns their paths.
fn write_images(dir: &TurnDir, images: &[Vec<u8>]) -> Result<Vec<std::path::PathBuf>, AiError> {
    images
        .iter()
        .enumerate()
        .map(|(index, bytes)| {
            let path = dir.path().join(format!("input-{index}.png"));
            std::fs::write(&path, bytes)
                .map_err(|_| AiError::Protocol("could not write an input picture".to_owned()))?;
            Ok(path)
        })
        .collect()
}

/// An output picture as a PNG data URL; the file is deleted either way.
fn take_output_image(path: &std::path::Path) -> Result<String, AiError> {
    let bytes = std::fs::read(path);
    let _ = std::fs::remove_file(path);
    bytes
        .map(|bytes| png_data_url(&bytes))
        .map_err(|_| AiError::Protocol("could not read the output picture".to_owned()))
}

struct Checked {
    request: AiRequest,
    images: Vec<Vec<u8>>,
    timeout: Duration,
}

fn check_request(request: AiRequest) -> Result<Checked, AiError> {
    validate_model(request.model.as_deref())?;
    validate_text(&request)?;
    let images = decode_images(&request.images)?;
    let timeout = clamp_timeout(request.timeout_ms);
    Ok(Checked {
        request,
        images,
        timeout,
    })
}

/// The blocking part of a run: scratch dir, adapter call, output.
fn run_turn(
    agent: &dyn AgentCli,
    checked: Checked,
    cancel: &CancelToken,
    on_event: &Channel<AiEvent>,
) -> Result<AiOutput, AiError> {
    let Checked {
        request,
        images,
        timeout,
    } = checked;
    // Owned here so the input pictures live as long as the run.
    let dir = if images.is_empty() {
        None
    } else {
        Some(
            TurnDir::new()
                .map_err(|_| AiError::Protocol("could not make a scratch folder".to_owned()))?,
        )
    };
    let paths = match &dir {
        Some(dir) => write_images(dir, &images)?,
        None => Vec::new(),
    };
    let run = RunRequest {
        system: request.system,
        prompt: request.prompt,
        schema: request.schema,
        images: paths,
        want_image: request.want_image,
        model: request.model,
        timeout,
    };
    let RunOutput { json, image } = agent.run(run, cancel, &mut |event| {
        if let Some(event) = to_ai_event(event) {
            // The window may have gone; the run still ends normally.
            let _ = on_event.send(event);
        }
    })?;
    let image = image.as_deref().map(take_output_image).transpose()?;
    Ok(AiOutput { json, image })
}

/// Runs one turn on `provider` and returns its output. Progress goes to
/// `on_event`. `mock` only applies to the `mock` provider, which exists in
/// debug builds only.
#[tauri::command]
#[specta::specta]
pub async fn ai_run(
    app: AppHandle,
    run_id: String,
    provider: String,
    request: AiRequest,
    mock: Option<AiMockScript>,
    on_event: Channel<AiEvent>,
) -> Result<AiOutput, AiError> {
    validate_run_id(&run_id)?;
    let agent = provider_for(&provider, mock).ok_or(AiError::Unsupported)?;
    let checked = check_request(request)?;
    let cancel = CancelToken::new();
    let _guard = RunGuard::register(&app, &run_id, cancel.clone())?;

    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_turn(agent.as_ref(), checked, &cancel, &on_event)
    })
    .await
    .unwrap_or_else(|_| Err(AiError::Protocol("the run stopped unexpectedly".to_owned())));

    log::info!(
        "ai run {run_id} on {provider}: {} after {} ms",
        result.as_ref().map_or_else(AiError::name, |_| "ok"),
        started.elapsed().as_millis()
    );
    result
}

/// Cancels a run in flight. An id that is not running is not an error: the
/// run already ended.
#[tauri::command]
#[specta::specta]
pub async fn ai_cancel(app: AppHandle, run_id: String) -> Result<(), AiError> {
    if let Some(token) = app.state::<AiRuns>().lock().get(&run_id) {
        token.cancel();
    }
    Ok(())
}

/// What each provider can do on this machine. Codex and Claude Code report
/// `available: false` until their adapters exist.
#[tauri::command]
#[specta::specta]
pub fn ai_detect() -> Vec<AiDetection> {
    let mut found = vec![
        AiDetection::unavailable("codex"),
        AiDetection::unavailable("claude"),
    ];
    #[cfg(debug_assertions)]
    found.push(AiDetection::from_mock(
        Mock::new(mock_script(None)).detect(),
    ));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_base64(extra: usize) -> String {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.resize(PNG_SIGNATURE.len() + extra, 0);
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn is_invalid<T: std::fmt::Debug>(result: Result<T, AiError>) -> bool {
        matches!(result, Err(AiError::InvalidRequest(_)))
    }

    #[test]
    fn run_ids_are_short_and_plain() {
        assert!(validate_run_id("run_1-A").is_ok());
        assert!(validate_run_id(&"a".repeat(64)).is_ok());
        assert!(is_invalid(validate_run_id("")));
        assert!(is_invalid(validate_run_id(&"a".repeat(65))));
        assert!(is_invalid(validate_run_id("has space")));
        assert!(is_invalid(validate_run_id("../x")));
    }

    #[test]
    fn a_model_cannot_look_like_a_flag() {
        assert!(validate_model(None).is_ok());
        assert!(validate_model(Some("gpt-5.1:high_2")).is_ok());
        assert!(is_invalid(validate_model(Some("--config"))));
        assert!(is_invalid(validate_model(Some("a b"))));
        assert!(is_invalid(validate_model(Some(""))));
        assert!(is_invalid(validate_model(Some(&"m".repeat(65)))));
    }

    #[test]
    fn images_must_be_a_few_valid_pngs() {
        let ok = decode_images(&[png_base64(10), png_base64(0)]).unwrap();
        assert_eq!(ok.len(), 2);
        assert!(is_invalid(decode_images(&vec![png_base64(1); 5])));
        assert!(is_invalid(decode_images(&["not base64!".to_owned()])));
        let jpeg = base64::engine::general_purpose::STANDARD.encode([0xFF, 0xD8, 0xFF, 0xE0]);
        assert!(is_invalid(decode_images(&[jpeg])));
        assert!(is_invalid(decode_images(&[png_base64(MAX_IMAGE_BYTES)])));
    }

    #[test]
    fn the_timeout_stays_between_five_and_three_hundred_seconds() {
        assert_eq!(clamp_timeout(None), Duration::from_secs(60));
        assert_eq!(clamp_timeout(Some(1)), Duration::from_secs(5));
        assert_eq!(clamp_timeout(Some(u32::MAX)), Duration::from_secs(300));
        assert_eq!(clamp_timeout(Some(20_000)), Duration::from_secs(20));
    }

    #[test]
    fn real_providers_have_no_adapter_yet() {
        assert!(provider_for("codex", None).is_none());
        assert!(provider_for("claude", None).is_none());
        assert!(provider_for("anything", None).is_none());
    }

    #[test]
    fn agent_errors_map_one_to_one() {
        assert_eq!(AiError::from(AgentError::NotLoggedIn), AiError::NotLoggedIn);
        assert_eq!(AiError::from(AgentError::Timeout), AiError::Timeout);
        assert_eq!(
            AiError::from(AgentError::Protocol("exit code 3".to_owned())),
            AiError::Protocol("exit code 3".to_owned())
        );
        assert_eq!(AiError::from(AgentError::Cancelled), AiError::Cancelled);
    }
}
