//! Capture entry point. For now it only proves the shortcut and tray reach the
//! app: it emits [`CaptureRequested`] and shows the editor. Region capture replaces the
//! body with "capture all monitors → overlay → clipboard → floating preview".

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_specta::Event;

use crate::app_windows;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum CaptureSource {
    Hotkey,
    Tray,
}

#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequested {
    pub source: CaptureSource,
}

pub fn request<R: Runtime>(app: &AppHandle<R>, source: CaptureSource) {
    log::info!("capture requested from {source:?}");
    app_windows::show(app, app_windows::EDITOR);
    if let Err(err) = (CaptureRequested { source }).emit(app) {
        log::warn!("could not emit capture request: {err}");
    }
}
