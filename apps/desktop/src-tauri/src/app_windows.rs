//! Labels and helpers for the app's webview windows (declared in tauri.conf.json).

use tauri::{AppHandle, Manager, Runtime};

pub const EDITOR: &str = "editor";
pub const SETTINGS: &str = "settings";

/// Show a window, restore it if minimised and bring it to the front.
pub fn show<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        log::error!("window `{label}` is not declared in tauri.conf.json");
        return;
    };
    let result = window
        .show()
        .and_then(|()| window.unminimize())
        .and_then(|()| window.set_focus());
    if let Err(err) = result {
        log::warn!("could not show window `{label}`: {err}");
    }
}
