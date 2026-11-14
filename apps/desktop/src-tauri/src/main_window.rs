//! The main window's views and how the rest of the app asks for one.
//!
//! The editor, history and settings share one window; a rail inside it
//! switches between them. Every entry point (tray, floating preview, second
//! launch, startup problems) goes through [`show_main`], which records the
//! view, tells an already open page and shows the window. A page that is still
//! loading reads the recorded view with `get_main_view`.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use crate::app_windows;

/// A view of the main window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum MainView {
    #[default]
    Editor,
    History,
    Settings,
}

/// The view most recently requested; a page that has just loaded starts there.
#[derive(Default)]
pub struct MainViewState(Mutex<MainView>);

impl MainViewState {
    pub fn set(&self, view: MainView) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = view;
    }

    pub fn get(&self) -> MainView {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A page of the settings view.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SettingsSection {
    #[default]
    Capture,
    Appearance,
    General,
    Ai,
    About,
}

/// The settings page last shown. It outlives the main window, which is
/// destroyed a few minutes after it is closed, and is kept in memory only, so
/// the view opens on the first page after a restart.
#[derive(Default)]
pub struct SettingsSectionState(Mutex<SettingsSection>);

impl SettingsSectionState {
    pub fn set(&self, section: SettingsSection) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = section;
    }

    pub fn get(&self) -> SettingsSection {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Another view of the main window was requested while its page is open.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct MainViewRequested {
    pub view: MainView,
}

/// Show the main window on `view`, creating the window first if needed.
/// Returns whether the window exists.
pub fn show_main<R: Runtime>(app: &AppHandle<R>, view: MainView) -> bool {
    app.state::<MainViewState>().set(view);
    if let Err(err) = (MainViewRequested { view }).emit(app) {
        log::warn!("could not emit the main view request: {err}");
    }
    app_windows::show(app, app_windows::MAIN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_starts_on_the_editor_and_remembers_the_last_request() {
        let state = MainViewState::default();
        assert_eq!(state.get(), MainView::Editor);
        state.set(MainView::Settings);
        assert_eq!(state.get(), MainView::Settings);
    }

    #[test]
    fn settings_open_on_the_first_page_and_remember_the_last_one() {
        let state = SettingsSectionState::default();
        assert_eq!(state.get(), SettingsSection::Capture);
        state.set(SettingsSection::About);
        assert_eq!(state.get(), SettingsSection::About);
    }
}
