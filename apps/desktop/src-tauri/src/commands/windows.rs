// Tauri commands receive `AppHandle` by value; the macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use serde::Deserialize;
use specta::Type;
use tauri::AppHandle;

use super::CommandError;
use crate::app_windows;

/// A window the app rail can open.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
pub enum AppWindow {
    Editor,
    History,
    Settings,
}

impl AppWindow {
    const fn label(self) -> &'static str {
        match self {
            Self::Editor => app_windows::EDITOR,
            Self::History => app_windows::HISTORY,
            Self::Settings => app_windows::SETTINGS,
        }
    }
}

/// Show a window, creating it first if needed, and bring it to the front.
///
/// Async on purpose: on Windows, creating a webview window from a synchronous
/// command deadlocks, because sync commands run on the main thread.
#[tauri::command]
#[specta::specta]
pub async fn open_window(app: AppHandle, window: AppWindow) -> Result<(), CommandError> {
    if app_windows::show(&app, window.label()) {
        Ok(())
    } else {
        Err(CommandError::OpenWindow)
    }
}
