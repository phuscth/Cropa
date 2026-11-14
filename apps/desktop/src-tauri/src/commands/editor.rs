// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use serde::Serialize;
use specta::Type;
use std::time::SystemTime;

use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use super::{CommandError, png_data_url};
use crate::editor::{self, EditorImage, ImportError, MAX_IMPORT_SIDE};
use crate::history::{History, HistoryChanged, epoch_millis};
use crate::state::AppState;

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

impl From<ImportError> for CommandError {
    fn from(err: ImportError) -> Self {
        match err {
            ImportError::Unreadable(detail) => Self::ImageImportUnreadable(detail),
            ImportError::TooLarge => Self::ImageImportTooLarge(MAX_IMPORT_SIDE),
        }
    }
}

/// Opens a picture the user dropped, pasted or picked as the editor's image, as a
/// capture would be: kept in the history when that is on, then shown. `data` is the
/// base64 of a PNG with no `data:` prefix; the WebView has decoded the picture and
/// checked it is under 50 MB, so Rust accepts only PNG.
#[tauri::command]
#[specta::specta]
pub async fn import_editor_image(app: AppHandle, data: String) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (png, image) = crate::editor::decode_import(&data)?;
        let imported_at = SystemTime::now();
        let save_history = app.state::<AppState>().lock().settings.save_history;
        let history_id = if save_history {
            match app.state::<History>().save(&image, imported_at) {
                Ok(id) => {
                    if let Err(err) = HistoryChanged.emit(&app) {
                        log::warn!("could not emit the history change: {err}");
                    }
                    Some(id)
                }
                Err(err) => {
                    log::warn!("could not save the imported image to history: {err}");
                    None
                }
            }
        } else {
            None
        };
        editor::open(&app, png, Some(epoch_millis(imported_at)), history_id);
        Ok(())
    })
    .await
    .map_err(|err| CommandError::ImageImportUnreadable(err.to_string()))?
}

/// Takes the image out of the editor, which goes back to its empty canvas. The history keeps its captures.
#[tauri::command]
#[specta::specta]
pub async fn clear_editor_image(app: AppHandle) -> Result<(), CommandError> {
    editor::clear(&app);
    Ok(())
}
