// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use std::time::SystemTime;

use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use super::{CommandError, png_data_url};
use crate::editor;
use crate::history::{History, HistoryChanged, HistoryError, HistoryItem};
use crate::platform::{self, Platform};

fn read_error(err: HistoryError) -> CommandError {
    match err {
        HistoryError::Missing => CommandError::HistoryMissing,
        other => CommandError::HistoryRead(other.to_string()),
    }
}

fn delete_error(err: HistoryError) -> CommandError {
    match err {
        HistoryError::Missing => CommandError::HistoryMissing,
        other => CommandError::HistoryDelete(other.to_string()),
    }
}

/// Run file and image work off the main thread.
async fn blocking<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&History) -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<History>()))
        .await
        .map_err(|err| CommandError::HistoryRead(err.to_string()))?
}

fn announce_change(app: &AppHandle) {
    if let Err(err) = HistoryChanged.emit(app) {
        log::warn!("could not emit the history change: {err}");
    }
}

#[tauri::command]
#[specta::specta]
pub async fn list_history(app: AppHandle) -> Result<Vec<HistoryItem>, CommandError> {
    blocking(&app, |history| Ok(history.list(SystemTime::now()))).await
}

/// The thumbnail of one capture as a `data:` URL.
#[tauri::command]
#[specta::specta]
pub async fn get_history_thumbnail(app: AppHandle, id: String) -> Result<String, CommandError> {
    blocking(&app, move |history| {
        let png = history.thumbnail(&id).map_err(read_error)?;
        Ok(png_data_url(&png))
    })
    .await
}

/// Put the original capture back on the clipboard.
#[tauri::command]
#[specta::specta]
pub async fn copy_history_image(app: AppHandle, id: String) -> Result<(), CommandError> {
    blocking(&app, move |history| {
        let png = history.original(&id).map_err(read_error)?;
        let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .map_err(|err| CommandError::HistoryRead(err.to_string()))?
            .into_rgba8();
        platform::current()
            .copy_image(&image)
            .map_err(|err| CommandError::Clipboard(err.to_string()))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_history_image(app: AppHandle, id: String) -> Result<(), CommandError> {
    blocking(&app, move |history| {
        history.delete(&id).map_err(delete_error)
    })
    .await?;
    announce_change(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_all_history(app: AppHandle) -> Result<(), CommandError> {
    blocking(&app, |history| history.delete_all().map_err(delete_error)).await?;
    announce_change(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn open_history_in_editor(app: AppHandle, id: String) -> Result<(), CommandError> {
    let png = blocking(&app, move |history| {
        history.original(&id).map_err(read_error)
    })
    .await?;
    editor::open(&app, png);
    Ok(())
}
