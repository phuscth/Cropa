//! Typed Tauri commands. Every command here is also listed in `build.rs` so it
//! gets an `allow-*` permission, and each window's capability grants only what
//! that window needs.

pub mod editor;
pub mod history;
pub mod settings;

use serde::Serialize;
use specta::Type;

use crate::shortcut::ShortcutErrorKind;

/// Error returned to the WebView. The UI turns `kind` into a translated
/// message (what happened, why, what to do next).
#[derive(Debug, thiserror::Error, Serialize, Type)]
#[serde(tag = "kind", content = "detail")]
pub enum CommandError {
    #[error("the shortcut is not a valid key combination")]
    ShortcutInvalid,
    #[error("another app already uses this shortcut")]
    ShortcutInUse,
    #[error("could not save settings: {0}")]
    SaveSettings(String),
    #[error("could not change start-at-login: {0}")]
    Autostart(String),
    #[error("Windows or another app already uses the Print Screen key")]
    PrintScreenInUse,
    #[error("could not open the Windows setting: {0}")]
    OpenSystemSetting(String),
    #[error("that capture is not in the history")]
    HistoryMissing,
    #[error("could not read the capture: {0}")]
    HistoryRead(String),
    #[error("could not delete the capture: {0}")]
    HistoryDelete(String),
    #[error("could not copy to the clipboard: {0}")]
    Clipboard(String),
}

/// A PNG as a `data:` URL the WebView can show in an `<img>`.
pub(crate) fn png_data_url(png: &[u8]) -> String {
    use base64::Engine;

    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

impl From<ShortcutErrorKind> for CommandError {
    fn from(kind: ShortcutErrorKind) -> Self {
        match kind {
            ShortcutErrorKind::Invalid => Self::ShortcutInvalid,
            ShortcutErrorKind::InUse => Self::ShortcutInUse,
            ShortcutErrorKind::PrintScreenInUse => Self::PrintScreenInUse,
        }
    }
}
