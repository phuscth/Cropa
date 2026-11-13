//! The provider-independent surface of one AI turn.

use std::path::PathBuf;
use std::time::Duration;

use crate::cancel::CancelToken;

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
    pub timeout: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub json: Option<serde_json::Value>,
    /// A picture the CLI produced. The caller reads it and deletes it.
    pub image: Option<PathBuf>,
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
    /// Partial model output, for a progress indicator.
    Delta { text: String },
}

pub trait AgentCli: Send + Sync {
    fn detect(&self) -> Detection;

    /// Runs one turn, blocking the calling thread. `on_event` is called on
    /// that same thread.
    fn run(
        &self,
        req: RunRequest,
        cancel: &CancelToken,
        on_event: &mut dyn FnMut(Event),
    ) -> Result<RunOutput, AgentError>;
}
