// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use std::time::SystemTime;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use super::{CommandError, png_data_url};
use crate::chat::{ChatError, ChatMessage};
use crate::editor;
use crate::history::{History, HistoryChanged, HistoryError, HistoryItem};
use crate::platform::{self, Platform};
use crate::state::AppState;

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

fn chat_error(err: ChatError) -> CommandError {
    match err {
        ChatError::Invalid(field) => CommandError::ChatInvalid(field.to_owned()),
        ChatError::TooNew => CommandError::ChatTooNew,
        ChatError::Read(detail) => CommandError::ChatRead(detail),
        ChatError::Save(detail) => CommandError::ChatSave(detail),
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
    let exclude = app
        .state::<AppState>()
        .lock()
        .settings
        .exclude_from_clipboard_history;
    blocking(&app, move |history| {
        let png = history.original(&id).map_err(read_error)?;
        let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .map_err(|err| CommandError::HistoryRead(err.to_string()))?
            .into_rgba8();
        platform::current()
            .copy_image(&image, exclude)
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

/// A capture a batch delete could not remove.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDeleteFailure {
    pub id: String,
    pub error: CommandError,
}

/// Delete several captures. The ones that could not be removed come back with the reason.
#[tauri::command]
#[specta::specta]
pub async fn delete_history_images(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<Vec<HistoryDeleteFailure>, CommandError> {
    let total = ids.len();
    let failures = blocking(&app, move |history| {
        Ok(history
            .delete_each(&ids)
            .into_iter()
            .map(|(id, err)| HistoryDeleteFailure {
                id,
                error: delete_error(err),
            })
            .collect::<Vec<_>>())
    })
    .await?;
    if failures.len() < total {
        announce_change(&app);
    }
    Ok(failures)
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
    let (png, captured_at, id) = blocking(&app, move |history| {
        let png = history.original(&id).map_err(read_error)?;
        Ok((png, History::captured_at(&id).ok(), id))
    })
    .await?;
    editor::open(&app, png, captured_at, Some(id));
    Ok(())
}

/// The conversation kept for a capture; empty when there is none.
#[tauri::command]
#[specta::specta]
pub async fn get_chat(
    app: AppHandle,
    history_id: String,
) -> Result<Vec<ChatMessage>, CommandError> {
    blocking(&app, move |history| {
        history.chat(&history_id).map_err(chat_error)
    })
    .await
}

/// Replaces the conversation kept for a capture. `false` means the capture is not in the
/// history, so nothing was written.
#[tauri::command]
#[specta::specta]
pub async fn save_chat(
    app: AppHandle,
    history_id: String,
    messages: Vec<ChatMessage>,
) -> Result<bool, CommandError> {
    blocking(&app, move |history| {
        history.save_chat(&history_id, messages).map_err(chat_error)
    })
    .await
}
