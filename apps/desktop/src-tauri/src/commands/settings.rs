// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use super::CommandError;
use crate::settings::{self, Settings};
use crate::shortcut::{self, ShortcutStatus};
use crate::state::AppState;

fn persist(state: &AppState, update: impl FnOnce(&mut Settings)) -> Result<Settings, CommandError> {
    let mut inner = state.lock();
    let mut next = inner.settings.clone();
    update(&mut next);
    settings::save(&inner.settings_path, &next)
        .map_err(|err| CommandError::SaveSettings(err.to_string()))?;
    inner.settings = next.clone();
    Ok(next)
}

#[tauri::command]
#[specta::specta]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.lock().settings.clone()
}

#[tauri::command]
#[specta::specta]
pub fn get_shortcut_status(state: State<'_, AppState>) -> ShortcutStatus {
    state.lock().shortcut.clone()
}

/// Change the capture shortcut. On conflict the old shortcut keeps working
/// and nothing is saved.
#[tauri::command]
#[specta::specta]
pub fn set_capture_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    accelerator: String,
) -> Result<ShortcutStatus, CommandError> {
    let accelerator = accelerator.trim();
    let status = shortcut::change(&app, accelerator)?;
    persist(&state, |s| accelerator.clone_into(&mut s.capture_shortcut))?;
    Ok(status)
}

#[tauri::command]
#[specta::specta]
pub fn set_autostart(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<Settings, CommandError> {
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|err| CommandError::Autostart(err.to_string()))?;
    persist(&state, |s| s.autostart = enabled)
}
