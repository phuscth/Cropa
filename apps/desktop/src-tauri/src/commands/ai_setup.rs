//! Remembering the model choice and getting a provider's CLI ready: the
//! settings that belong to AI, the install guide and a terminal for logging in.
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
use crate::settings::{AiEffort, AiProvider, FavoriteModel, MAX_FAVORITE_MODELS, Settings};
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

/// The mock provider exists in debug builds only.
fn check_provider(provider: AiProvider) -> Result<(), CommandError> {
    if cfg!(not(debug_assertions)) && provider == AiProvider::Mock {
        Err(CommandError::AiProviderUnavailable)
    } else {
        Ok(())
    }
}

/// Remember the model picked for a message: its provider, and the model, where
/// `None` means the CLI's default.
#[tauri::command]
#[specta::specta]
pub fn set_ai_model(
    state: State<'_, AppState>,
    provider: AiProvider,
    model: Option<String>,
) -> Result<Settings, CommandError> {
    check_provider(provider)?;
    if model
        .as_deref()
        .is_some_and(|name| !cropa_agent::valid_model_name(name))
    {
        return Err(CommandError::AiModelInvalid);
    }
    persist(&state, |s| {
        s.ai.last_provider = Some(provider);
        s.ai.last_model = model;
    })
}

/// Star or unstar a model in the picker.
#[tauri::command]
#[specta::specta]
pub fn set_ai_favorite_model(
    state: State<'_, AppState>,
    provider: AiProvider,
    model: String,
    favorite: bool,
) -> Result<Settings, CommandError> {
    check_provider(provider)?;
    if !cropa_agent::valid_model_name(&model) {
        return Err(CommandError::AiModelInvalid);
    }
    let entry = FavoriteModel { provider, model };
    let current = state.lock().settings.ai.favorite_models.clone();
    if !can_set_favorite(&current, &entry, favorite) {
        return Err(CommandError::AiModelInvalid);
    }
    persist(&state, |s| {
        set_favorite(&mut s.ai.favorite_models, entry, favorite);
    })
}

/// Whether starring `entry` is allowed: a new star past the cap is not.
fn can_set_favorite(list: &[FavoriteModel], entry: &FavoriteModel, favorite: bool) -> bool {
    !favorite || list.contains(entry) || list.len() < MAX_FAVORITE_MODELS
}

/// Adds `entry` if it is absent, or removes it; a model is never listed twice.
fn set_favorite(list: &mut Vec<FavoriteModel>, entry: FavoriteModel, favorite: bool) {
    if favorite {
        if !list.contains(&entry) {
            list.push(entry);
        }
    } else {
        list.retain(|existing| *existing != entry);
    }
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

/// Remember how much effort AI tasks use. Low, medium or high only.
#[tauri::command]
#[specta::specta]
pub fn set_ai_effort(
    state: State<'_, AppState>,
    effort: AiEffort,
) -> Result<Settings, CommandError> {
    persist(&state, |s| s.ai.effort = effort)
}

/// End the first-launch AI question, whatever the user did with it.
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
    fn the_mock_provider_is_refused_only_in_release_builds() {
        assert!(check_provider(AiProvider::Codex).is_ok());
        assert!(check_provider(AiProvider::Claude).is_ok());
        assert_eq!(
            check_provider(AiProvider::Mock).is_err(),
            cfg!(not(debug_assertions))
        );
    }

    fn star(provider: AiProvider, model: &str) -> FavoriteModel {
        FavoriteModel {
            provider,
            model: model.to_owned(),
        }
    }

    #[test]
    fn starring_adds_once_and_unstarring_removes_only_that_model() {
        let mut list = Vec::new();
        set_favorite(&mut list, star(AiProvider::Codex, "a"), true);
        set_favorite(&mut list, star(AiProvider::Claude, "a"), true);
        set_favorite(&mut list, star(AiProvider::Codex, "a"), true);
        assert_eq!(
            list,
            [star(AiProvider::Codex, "a"), star(AiProvider::Claude, "a")]
        );
        set_favorite(&mut list, star(AiProvider::Codex, "a"), false);
        set_favorite(&mut list, star(AiProvider::Codex, "missing"), false);
        assert_eq!(list, [star(AiProvider::Claude, "a")]);
    }

    #[test]
    fn a_new_star_past_the_cap_is_refused_but_an_existing_one_is_not() {
        let list: Vec<_> = (0..MAX_FAVORITE_MODELS)
            .map(|i| star(AiProvider::Codex, &format!("m{i}")))
            .collect();
        assert!(!can_set_favorite(
            &list,
            &star(AiProvider::Codex, "new"),
            true
        ));
        assert!(can_set_favorite(
            &list,
            &star(AiProvider::Codex, "m0"),
            true
        ));
        assert!(can_set_favorite(
            &list,
            &star(AiProvider::Codex, "new"),
            false
        ));
        assert!(can_set_favorite(
            &list[1..],
            &star(AiProvider::Codex, "new"),
            true
        ));
    }

    #[test]
    fn each_cli_maps_to_its_own_executable() {
        assert_eq!(AiCli::Codex.provider().executable(), "codex");
        assert_eq!(AiCli::Claude.provider().executable(), "claude");
    }
}
