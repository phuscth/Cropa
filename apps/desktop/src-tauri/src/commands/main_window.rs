// Tauri commands receive `State` by value; the macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use tauri::{AppHandle, State};

use crate::capture::{self, CaptureSource};
use crate::main_window::{MainView, MainViewState};

/// The view the main window should show when its page loads. It only reads
/// state and creates no window, so it may be a synchronous command.
#[tauri::command]
#[specta::specta]
pub fn get_main_view(state: State<'_, MainViewState>) -> MainView {
    state.get()
}

/// Start a region capture, as the capture shortcut and the tray do. It returns
/// at once: the capture runs on its own thread.
#[tauri::command]
#[specta::specta]
pub async fn request_capture(app: AppHandle) {
    capture::request(&app, CaptureSource::Menu);
}
