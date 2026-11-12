//! Drives the user's own Codex and Claude Code CLIs (ROADMAP §3.3).
//!
//! Phase 0 only reserves the crate. The `AgentCli` trait and the one-turn
//! `codex exec` / `claude -p` transports land in Phase 2 (ADR 0006).

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
