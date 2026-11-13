//! Typed Tauri commands. Every command here is also listed in `build.rs` so it
//! gets an `allow-*` permission, and each window's capability grants only what
//! that window needs.

pub mod ai;
pub mod ai_setup;
pub mod background_images;
pub mod editor;
pub mod export;
pub mod history;
pub mod main_window;
pub mod presets;
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
    #[error("the image is not a valid picture in the expected format")]
    ExportInvalid,
    #[error("the image is larger than {0} MB")]
    ExportTooLarge(u32),
    #[error("could not save the file: {0}")]
    SaveFile(String),
    #[error("the Save as choice is no longer valid")]
    SaveAsExpired,
    #[error("could not open the file dialog: {0}")]
    SaveDialog(String),
    #[error("that file is no longer where it was saved")]
    SavedFileGone,
    #[error("could not start dragging the image: {0}")]
    Drag(String),
    #[error("could not open the folder: {0}")]
    OpenFolder(String),
    #[error("could not open the web page: {0}")]
    OpenWebPage(String),
    #[error("the preset name must have 1 to 40 characters and no control characters")]
    UserPresetName,
    #[error("the preset background is not valid: {0}")]
    UserPresetInvalid(String),
    #[error("the preset background is too large")]
    UserPresetTooLarge,
    #[error("there are already as many presets as Cropa can keep")]
    UserPresetsFull,
    #[error("that preset does not exist")]
    UserPresetMissing,
    #[error("the presets file was written by a newer version of Cropa")]
    UserPresetsTooNew,
    #[error("could not read the presets: {0}")]
    UserPresetsRead(String),
    #[error("could not save the presets: {0}")]
    UserPresetsSave(String),
    #[error("the file is not a PNG, JPEG or WebP picture")]
    BackgroundImageNotSupported,
    #[error("the picture is larger than {0} MB")]
    BackgroundImageTooLarge(u32),
    #[error("there are already as many background images as Cropa can keep")]
    BackgroundImagesFull,
    #[error("that background image does not exist")]
    BackgroundImageMissing,
    #[error("the background images were saved by a newer version of Cropa")]
    BackgroundImagesTooNew,
    #[error("could not read the background images: {0}")]
    BackgroundImagesRead(String),
    #[error("could not save the background image: {0}")]
    BackgroundImagesSave(String),
    #[error("the test provider is not available in this build")]
    AiProviderUnavailable,
    #[error("the AI command line tool was not found")]
    AiCliNotFound,
    #[error("could not open a terminal: {0}")]
    OpenTerminal(String),
}

/// An image as a `data:` URL the WebView can show in an `<img>`.
pub(crate) fn image_data_url(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine;

    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// A PNG as a `data:` URL the WebView can show in an `<img>`.
pub(crate) fn png_data_url(png: &[u8]) -> String {
    image_data_url("image/png", png)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_data_url_names_the_type_and_carries_the_bytes_in_base64() {
        assert_eq!(
            image_data_url("image/webp", b"abc"),
            "data:image/webp;base64,YWJj"
        );
        assert_eq!(png_data_url(b"abc"), "data:image/png;base64,YWJj");
    }
}
