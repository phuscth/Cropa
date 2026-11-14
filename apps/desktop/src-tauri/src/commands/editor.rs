// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};

use super::{CommandError, png_data_url};
use crate::editor::EditorImage;

/// What the editor shows: the image and when it was captured.
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorImageData {
    /// A `data:` URL.
    pub image: String,
    /// Milliseconds since the Unix epoch; `None` when the capture time is unknown.
    pub captured_at: Option<f64>,
    /// The capture's id in the history, when it is kept there. The chat is stored under it.
    pub history_id: Option<String>,
}

/// The image the editor shows with its capture time, or `None` when it has none.
#[tauri::command]
#[specta::specta]
pub async fn get_editor_image(app: AppHandle) -> Result<Option<EditorImageData>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<EditorImage>()
            .get()
            .map(|current| EditorImageData {
                image: png_data_url(&current.png),
                captured_at: current.captured_at,
                history_id: current.history_id,
            })
    })
    .await
    .map_err(|err| CommandError::HistoryRead(err.to_string()))
}
