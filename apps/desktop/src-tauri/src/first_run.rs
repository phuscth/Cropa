//! First-launch question: start Cropa with Windows or not.

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

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

/// Ask once, ever, whether Cropa should start with Windows. The answer is
/// applied right away and the question is marked as answered in
/// `settings.json`, so it is never asked again, even after an update.
///
/// The dialog is modal, so it runs on its own thread and never blocks setup or
/// the event loop.
pub fn ask_autostart_once(app: &AppHandle, lang: Lang) {
    if app.state::<AppState>().lock().settings.autostart_asked {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let text = first_run_text(lang);
        let platform = platform::current();
        let answer = match platform.ask_yes_no(text.title, text.question) {
            Ok(answer) => answer,
            Err(err) => {
                // Not marked as answered: it is asked again next launch.
                log::warn!("could not ask about start with Windows: {err}");
                return;
            }
        };
        match set_autostart(app.clone(), answer) {
            Ok(enabled) => {
                if let Err(err) = (AutostartChanged { enabled }).emit(&app) {
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
    });
}
