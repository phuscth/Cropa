// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;

use super::CommandError;
use crate::i18n::{self, Lang};
use crate::platform::OwnerWindow;
use crate::platform::Platform;
use crate::settings::{self, Settings, ThemePreference};
use crate::shortcut::{self, ShortcutStatus};
use crate::state::AppState;

pub(crate) fn persist(
    state: &AppState,
    update: impl FnOnce(&mut Settings),
) -> Result<Settings, CommandError> {
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

/// Change the capture shortcut. The new shortcut only takes over once it is
/// saved: on a conflict or a failed save, the old shortcut keeps working and
/// `settings.json` is unchanged.
#[tauri::command]
#[specta::specta]
pub fn set_capture_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    accelerator: String,
) -> Result<ShortcutStatus, CommandError> {
    let accelerator = accelerator.trim();
    let pending = shortcut::begin_change(&app, accelerator)?;
    match persist(&state, |s| accelerator.clone_into(&mut s.capture_shortcut)) {
        Ok(_) => Ok(pending.commit(&app)),
        Err(err) => {
            pending.rollback(&app);
            Err(err)
        }
    }
}

/// Open the Windows page where the user can stop Windows from using the Print
/// Screen key for its own screen snipping.
#[tauri::command]
#[specta::specta]
pub fn open_print_screen_setting() -> Result<(), CommandError> {
    crate::platform::current()
        .open_print_screen_setting()
        .map_err(|err| CommandError::OpenSystemSetting(err.to_string()))
}

/// Change the colour theme and apply it to every window, open or opened later.
#[tauri::command]
#[specta::specta]
pub fn set_theme(
    app: AppHandle,
    state: State<'_, AppState>,
    theme: ThemePreference,
) -> Result<Settings, CommandError> {
    let saved = persist(&state, |s| s.theme = theme)?;
    app.set_theme(theme.to_tauri());
    Ok(saved)
}

/// Turn saving each capture to the history folder on or off. Captures already
/// in the history stay.
#[tauri::command]
#[specta::specta]
pub fn set_save_history(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<Settings, CommandError> {
    persist(&state, |s| s.save_history = enabled)
}

/// Keep captures out of Windows clipboard history and cloud sync, or not.
#[tauri::command]
#[specta::specta]
pub fn set_exclude_from_clipboard_history(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<Settings, CommandError> {
    persist(&state, |s| s.exclude_from_clipboard_history = enabled)
}

/// Whether Cropa starts at sign-in, read from Windows each time: the user can
/// change it outside Cropa (Task Manager › Startup apps).
#[tauri::command]
#[specta::specta]
pub fn get_autostart(app: AppHandle) -> Result<bool, CommandError> {
    app.autolaunch()
        .is_enabled()
        .map_err(|err| CommandError::Autostart(err.to_string()))
}

/// Turn start-at-sign-in on or off and return what Windows now reports.
#[tauri::command]
#[specta::specta]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, CommandError> {
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|err| CommandError::Autostart(err.to_string()))?;
    get_autostart(app)
}

/// Where the user can sponsor Cropa.
const SPONSORS_URL: &str = "https://github.com/sponsors/phuscth";

/// Pick the folder Ctrl+S saves into. `None` when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn choose_save_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<Settings>, CommandError> {
    let owner = OwnerWindow::of(&window);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let current = state.lock().settings.save_folder.clone();
        let text = i18n::save_dialog_text(Lang::detect());
        let picked = crate::platform::current()
            .pick_folder(owner, text.pick_folder_title, current.as_deref())
            .map_err(|err| CommandError::SaveDialog(err.to_string()))?;
        picked
            .map(|dir| persist(&state, |s| s.save_folder = Some(dir)))
            .transpose()
    })
    .await
    .map_err(|err| CommandError::SaveDialog(err.to_string()))?
}

/// Forget the save folder: Cropa asks again the next time the user saves.
#[tauri::command]
#[specta::specta]
pub fn reset_save_folder(state: State<'_, AppState>) -> Result<Settings, CommandError> {
    persist(&state, |s| s.save_folder = None)
}

/// Open the GitHub Sponsors page in the default browser.
#[tauri::command]
#[specta::specta]
pub fn open_sponsors_page() -> Result<(), CommandError> {
    crate::platform::current()
        .open_web_page(SPONSORS_URL)
        .map_err(|err| CommandError::OpenWebPage(err.to_string()))
}
