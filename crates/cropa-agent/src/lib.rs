//! Drives the user's own Codex and Claude Code CLIs.
//!
//! The crate holds what every provider shares: the `AgentCli` trait and its
//! request and output types, a scriptable `Mock`, the process runner that
//! kills the whole process tree, the environment allowlist, a `PATH` search
//! and the per-turn scratch directory. The Codex and Claude Code adapters
//! build on these. Everything here is synchronous; callers run it on a
//! blocking thread.

mod adapter;
mod cancel;
mod claude;
mod cli;
mod codex;
#[cfg(feature = "diagnostics")]
mod diag;
mod env;
mod mock;
mod path_search;
mod runner;
mod turn_dir;

pub use adapter::valid_model_name;
pub use cancel::CancelToken;
pub use claude::{ClaudeCode, ENABLED as CLAUDE_ENABLED};
pub use cli::{AgentCli, AgentError, Detection, Effort, Event, ModelInfo, RunOutput, RunRequest};
pub use codex::{CodexExec, ENABLED as CODEX_ENABLED};
pub use env::{BASE_ENV_ALLOWLIST, base_env, filter_env};
pub use mock::{Mock, MockScript};
pub use path_search::{find_executable, find_in};
pub use runner::{
    Captured, Finished, LineFlow, ProcessError, ProcessSpec, run_capture, run_process,
};
pub use turn_dir::{TurnDir, remove_stale};

/// Which CLI a run goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Codex,
    ClaudeCode,
}

impl Provider {
    /// Executable name looked up on `PATH`.
    pub const fn executable(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Provider;

    #[test]
    fn executable_names_match_the_official_clis() {
        assert_eq!(Provider::Codex.executable(), "codex");
        assert_eq!(Provider::ClaudeCode.executable(), "claude");
    }
}
