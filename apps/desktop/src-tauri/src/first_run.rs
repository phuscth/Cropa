//! First-launch questions: start Cropa with Windows or not, then set up AI.

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::app_windows;
use crate::commands::settings::{persist, set_autostart};
use crate::i18n::{Lang, autostart_failed_text, first_run_text};
use crate::platform::{self, Platform};
use crate::state::AppState;

/// What Windows reports for start-at-sign-in after the first-launch answer,
/// so an open Settings window can update its checkbox.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AutostartChanged {
    pub enabled: bool,
}

/// Run the first-launch questions: whether Cropa should start with Windows,
/// then AI setup. Each is asked once, ever, and its answer is saved in
/// `settings.json`, so it is never asked again, even after an update.
///
/// The autostart dialog is modal, so it runs on its own thread and never
/// blocks setup or the event loop.
pub fn run(app: &AppHandle, lang: Lang) {
    if app.state::<AppState>().lock().settings.autostart_asked {
        offer_ai_setup(app);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        ask_autostart(&app, lang);
        offer_ai_setup(&app);
    });
}

/// Open the Settings window, which shows the AI setup panel until the user
/// picks a provider or chooses "Later".
fn offer_ai_setup(app: &AppHandle) {
    if !app
        .state::<AppState>()
        .lock()
        .settings
        .ai
        .onboarding_answered
    {
        app_windows::show(app, app_windows::SETTINGS);
    }
}

/// Ask the autostart question and apply the answer. When the dialog fails the
/// question is not marked as answered, so it is asked again next launch.
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
    match set_autostart(app.clone(), answer) {
        Ok(enabled) => {
            if let Err(err) = (AutostartChanged { enabled }).emit(app) {
                log::warn!("could not emit the start-with-Windows change: {err}");
            }
        }
        Err(err) => {
            log::warn!("could not apply the start-with-Windows answer: {err}");
            let notice = autostart_failed_text(lang, answer, &err.to_string());
            if let Err(err) = platform.show_warning(text.title, &notice) {
                log::warn!("could not show the start-with-Windows notice: {err}");
            }
        }
    }
    if let Err(err) = persist(&app.state::<AppState>(), |s| s.autostart_asked = true) {
        log::warn!("could not remember the start-with-Windows answer: {err}");
    }
}
