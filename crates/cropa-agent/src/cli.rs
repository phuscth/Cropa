//! The provider-independent surface of one AI turn.

use std::path::PathBuf;
use std::time::Duration;

use crate::cancel::CancelToken;

/// How much thinking a turn may spend. Higher is slower and uses more of the user's quota.
/// The adapters turn each value into a fixed argument, so a request can never carry any other text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Effort {
    #[default]
    Low,
    Medium,
    High,
}

impl Effort {
    /// The word both CLIs use for this level.
    pub const fn as_arg(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

/// One turn: a system prompt, a prompt and optional input pictures.
#[derive(Debug, Clone)]
pub struct RunRequest {
    pub system: String,
    pub prompt: String,
    /// JSON schema the reply must follow.
    pub schema: Option<serde_json::Value>,
    /// Input files the adapter attaches.
    pub images: Vec<PathBuf>,
    pub want_image: bool,
    pub model: Option<String>,
    pub effort: Effort,
    pub timeout: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub json: Option<serde_json::Value>,
    /// The PNG the CLI produced. Cropa reads it and leaves the file where the CLI wrote it.
    pub image: Option<Vec<u8>>,
}

/// Why a turn did not produce an output. `Protocol` carries a short fixed
/// description and never any prompt, stdout or stderr content.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AgentError {
    #[error("the CLI is not installed")]
    NotInstalled,
    #[error("the CLI is not logged in")]
    NotLoggedIn,
    #[error("the CLI reached its usage limit")]
    UsageLimit,
    #[error("the CLI cannot do this")]
    Unsupported,
    #[error("the CLI took too long")]
    Timeout,
    #[error("unexpected CLI behaviour: {0}")]
    Protocol(String),
    #[error("the run was cancelled")]
    Cancelled,
    #[error("the CLI finished without an image")]
    NoImage,
}

/// What a provider can do on this machine.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Detection {
    /// Absolute path found on `PATH`; `None` means not installed.
    pub executable: Option<PathBuf>,
    pub version: Option<String>,
    /// Whether `version` meets the minimum the adapter was verified on.
    /// `None` when the version is unknown.
    pub version_supported: Option<bool>,
    /// `None` means unknown or not checked.
    pub logged_in: Option<bool>,
    pub image_in: bool,
    pub image_out: bool,
}

/// Streamed while a turn runs.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Event {
    /// The process runs and the prompt was sent.
    Started,
    /// Reply text (prose) as it arrives.
    Delta { text: String },
    /// Reasoning the CLI exposes, as it arrives. It is the summary the CLI chooses to
    /// show, not the raw chain of thought, and some turns send none.
    Thinking { text: String },
    /// The structured answer as raw JSON text while it is being written; the text so far
    /// may be incomplete JSON. The final value still comes in `RunOutput`.
    OutputDelta { text: String },
}

/// A model the CLI offers, as it reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    /// The value for `--model`; passes `valid_model_name`.
    pub id: String,
    pub display_name: String,
    pub description: String,
    /// The model the CLI uses when no `--model` is given.
    pub is_default: bool,
    /// The CLI announces it as newly available.
    pub is_new: bool,
}

pub trait AgentCli: Send + Sync {
    fn detect(&self) -> Detection;

    /// Asks the CLI which models it offers, without spending a turn. Blocks
    /// the calling thread.
    fn list_models(&self, cancel: &CancelToken) -> Result<Vec<ModelInfo>, AgentError>;

    /// Runs one turn, blocking the calling thread. `on_event` is called on
    /// that same thread.
    fn run(
        &self,
        req: RunRequest,
        cancel: &CancelToken,
        on_event: &mut dyn FnMut(Event),
    ) -> Result<RunOutput, AgentError>;
}
