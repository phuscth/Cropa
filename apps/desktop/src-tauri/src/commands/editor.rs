// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use tauri::{AppHandle, Manager};

use super::{CommandError, png_data_url};
use crate::editor::EditorImage;

/// The image the editor shows, as a `data:` URL, or `None` when it has none.
#[tauri::command]
#[specta::specta]
pub async fn get_editor_image(app: AppHandle) -> Result<Option<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<EditorImage>()
            .get()
            .map(|png| png_data_url(&png))
    })
    .await
    .map_err(|err| CommandError::HistoryRead(err.to_string()))
}
