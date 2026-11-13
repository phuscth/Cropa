//! First-launch questions, asked in the welcome window: start Cropa with
//! Windows or not, then set up AI.

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::app_windows;
use crate::commands::CommandError;
use crate::commands::settings::{persist, set_autostart};
use crate::i18n::{Lang, autostart_failed_text, first_run_text, onboarding_title};
use crate::platform::{self, Platform};
use crate::settings::Settings;
use crate::state::AppState;

/// What Windows reports for start-at-sign-in after the first-launch answer,
/// so an open Settings view can update its checkbox.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AutostartChanged {
    pub enabled: bool,
}

/// Open the welcome window when a first-launch question is still unanswered.
/// Each question is asked once, ever, and its answer is saved in
/// `settings.json`, so it is never asked again, even after an update.
///
/// Only when the window cannot be created does the autostart question fall
/// back to a native dialog (on its own thread, since it is modal); AI setup is
/// then left unanswered and stays available in Settings.
pub fn run(app: &AppHandle, lang: Lang) {
    let settings = app.state::<AppState>().lock().settings.clone();
    if !wants_onboarding(&settings) {
        return;
    }
    if app_windows::show(app, app_windows::ONBOARDING) {
        // The title is translated here because windows are created with an
        // English one.
        if let Some(window) = app.get_webview_window(app_windows::ONBOARDING)
            && let Err(err) = window.set_title(onboarding_title(lang))
        {
            log::warn!("could not set the title of the welcome window: {err}");
        }
        return;
    }
    if fallback_needed(&settings) {
        let app = app.clone();
        std::thread::spawn(move || ask_autostart(&app, lang));
    }
}

/// The welcome window opens while any first-launch question is unanswered.
fn wants_onboarding(settings: &Settings) -> bool {
    !settings.autostart_asked || !settings.ai.onboarding_answered
}

/// When the welcome window cannot be created, only the autostart question
/// has a native fallback; AI setup stays unanswered and available in Settings.
fn fallback_needed(settings: &Settings) -> bool {
    !settings.autostart_asked
}

/// What closing the welcome window with X fills in: (turn autostart on and mark
/// it answered, mark the AI question answered). Answered questions are left
/// as they are.
fn close_defaults(settings: &Settings) -> (bool, bool) {
    (!settings.autostart_asked, !settings.ai.onboarding_answered)
}

/// Apply the answer to "Start Cropa with Windows?", tell open windows, and
/// mark the question as answered even when applying failed: it is asked once.
/// Returns what Windows now reports, or why applying failed.
pub fn apply_autostart_answer(app: &AppHandle, enabled: bool) -> Result<bool, CommandError> {
    let applied = set_autostart(app.clone(), enabled);
    if let Ok(enabled) = applied
        && let Err(err) = (AutostartChanged { enabled }).emit(app)
    {
        log::warn!("could not emit the start-with-Windows change: {err}");
    }
    let saved = persist(&app.state::<AppState>(), |s| s.autostart_asked = true);
    let enabled = applied?;
    saved?;
    Ok(enabled)
}

/// The welcome window was closed with X: whatever is still unanswered takes
/// its default (start with Windows on, AI not set up), so the window does not
/// come back. Finishing both steps first makes this do nothing.
pub fn onboarding_closed(app: &AppHandle) {
    let settings = app.state::<AppState>().lock().settings.clone();
    let (apply_autostart, mark_ai_answered) = close_defaults(&settings);
    if apply_autostart && let Err(err) = apply_autostart_answer(app, true) {
        log::warn!("could not apply the default start-with-Windows answer: {err}");
    }
    if mark_ai_answered
        && let Err(err) = persist(&app.state::<AppState>(), |s| {
            s.ai.onboarding_answered = true;
        })
    {
        log::warn!("could not remember the AI setup answer: {err}");
    }
}

/// The native question used when the welcome window cannot be created. When
/// the dialog fails the question is not marked as answered, so it is asked
/// again next launch.
fn ask_autostart(app: &AppHandle, lang: Lang) {
    let text = first_run_text(lang);
    let platform = platform::current();
    let answer = match platform.ask_yes_no(text.title, text.question) {
        Ok(answer) => answer,
        Err(err) => {
            log::warn!("could not ask about start with Windows: {err}");
            return;
        }
    };
    if let Err(err) = apply_autostart_answer(app, answer) {
        log::warn!("could not apply the start-with-Windows answer: {err}");
        let notice = autostart_failed_text(lang, answer, &err.to_string());
        if let Err(err) = platform.show_warning(text.title, &notice) {
            log::warn!("could not show the start-with-Windows notice: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AiSettings;

    fn settings(autostart_asked: bool, ai_answered: bool) -> Settings {
        Settings {
            autostart_asked,
            ai: AiSettings {
                onboarding_answered: ai_answered,
                ..AiSettings::default()
            },
            ..Settings::default()
        }
    }

    #[test]
    fn the_window_opens_while_any_question_is_unanswered() {
        assert!(wants_onboarding(&settings(false, false)));
        assert!(wants_onboarding(&settings(true, false)));
        assert!(wants_onboarding(&settings(false, true)));
        assert!(!wants_onboarding(&settings(true, true)));
    }

    #[test]
    fn only_an_unanswered_autostart_question_falls_back_to_the_dialog() {
        assert!(fallback_needed(&settings(false, false)));
        assert!(fallback_needed(&settings(false, true)));
        assert!(!fallback_needed(&settings(true, false)));
    }

    #[test]
    fn closing_with_x_fills_only_what_is_unanswered() {
        assert_eq!(close_defaults(&settings(false, false)), (true, true));
        assert_eq!(close_defaults(&settings(true, false)), (false, true));
        assert_eq!(close_defaults(&settings(false, true)), (true, false));
        assert_eq!(close_defaults(&settings(true, true)), (false, false));
    }
}
