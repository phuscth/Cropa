// Tauri commands receive `State` by value; the macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use tauri::State;

use crate::main_window::{MainView, MainViewState};

/// The view the main window should show when its page loads. It only reads
/// state and creates no window, so it may be a synchronous command.
#[tauri::command]
#[specta::specta]
pub fn get_main_view(state: State<'_, MainViewState>) -> MainView {
    state.get()
}
