//! Choosing the AI provider and getting its CLI ready: the settings that
//! belong to AI, the install guide and a terminal for logging in.
//!
//! Cropa never reads or stores the CLI's login: it only opens the CLI's own
//! login command in a console window the user types into. Every address and
//! argument here is fixed.

// Tauri commands receive `State` and arguments by value; the macro cannot take
// references.
#![allow(clippy::needless_pass_by_value)]

use cropa_agent::Provider;
use serde::Deserialize;
use specta::Type;
use tauri::State;

use super::CommandError;
use super::settings::persist;
use crate::platform::{self, Platform};
use crate::settings::{AiProvider, Settings};
use crate::state::AppState;

const CODEX_INSTALL_URL: &str = "https://developers.openai.com/codex/cli";
const CLAUDE_INSTALL_URL: &str = "https://code.claude.com/docs/en/setup";

/// A CLI Cropa can help set up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiCli {
    Codex,
    Claude,
}

impl AiCli {
    const fn provider(self) -> Provider {
        match self {
            Self::Codex => Provider::Codex,
            Self::Claude => Provider::ClaudeCode,
        }
    }

    const fn install_url(self) -> &'static str {
        match self {
            Self::Codex => CODEX_INSTALL_URL,
            Self::Claude => CLAUDE_INSTALL_URL,
        }
    }

    const fn login_args(self) -> &'static [&'static str] {
        match self {
            Self::Codex => &["login"],
            Self::Claude => &["auth", "login"],
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

/// Choose the provider every AI task uses, or turn AI off with `None`. Either
/// answer ends the first-launch AI question.
#[tauri::command]
#[specta::specta]
pub fn set_ai_provider(
    state: State<'_, AppState>,
    provider: Option<AiProvider>,
) -> Result<Settings, CommandError> {
    if cfg!(not(debug_assertions)) && provider == Some(AiProvider::Mock) {
        return Err(CommandError::AiProviderUnavailable);
    }
    persist(&state, |s| {
        s.ai.provider = provider;
        s.ai.onboarding_answered = true;
    })
}

/// Allow tasks to send screenshots to the provider, or not.
#[tauri::command]
#[specta::specta]
pub fn set_ai_allow_images(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<Settings, CommandError> {
    persist(&state, |s| s.ai.allow_images = enabled)
}

/// "Later" on the first-launch AI question: stop asking, keep the provider.
#[tauri::command]
#[specta::specta]
pub fn dismiss_ai_onboarding(state: State<'_, AppState>) -> Result<Settings, CommandError> {
    persist(&state, |s| s.ai.onboarding_answered = true)
}

/// Open the official install page of a CLI in the default browser.
#[tauri::command]
#[specta::specta]
pub fn open_ai_install_guide(provider: AiCli) -> Result<(), CommandError> {
    platform::current()
        .open_web_page(provider.install_url())
        .map_err(|err| CommandError::OpenWebPage(err.to_string()))
}

/// Run the CLI's own login command in a console window the user can type into.
#[tauri::command]
#[specta::specta]
pub async fn open_login_terminal(provider: AiCli) -> Result<(), CommandError> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let program = cropa_agent::find_executable(provider.provider().executable())
            .ok_or(CommandError::AiCliNotFound)?;
        platform::current()
            .open_console(&program, provider.login_args())
            .map_err(|err| CommandError::OpenTerminal(err.to_string()))
    })
    .await
    .map_err(|err| CommandError::OpenTerminal(err.to_string()))?;
    match &outcome {
        Ok(()) => log::info!("opened the {} login terminal", provider.name()),
        Err(_) => log::warn!("could not open the {} login terminal", provider.name()),
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_runs_the_login_command_of_each_cli() {
        assert_eq!(AiCli::Codex.login_args(), ["login"]);
        assert_eq!(AiCli::Claude.login_args(), ["auth", "login"]);
    }

    #[test]
    fn each_cli_maps_to_its_own_executable() {
        assert_eq!(AiCli::Codex.provider().executable(), "codex");
        assert_eq!(AiCli::Claude.provider().executable(), "claude");
    }
}
