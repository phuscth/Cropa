//! Drives the user's own Codex and Claude Code CLIs.
//!
//! The crate is reserved for now. The `AgentCli` trait and the one-turn
//! `codex exec` / `claude -p` transports come with the AI features.

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
