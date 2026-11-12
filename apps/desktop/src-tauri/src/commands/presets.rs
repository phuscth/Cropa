// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use serde::Deserialize;
use specta::Type;
use tauri::{AppHandle, Manager};

use super::CommandError;
use crate::presets::{PresetsError, UserPreset, UserPresets};

impl From<PresetsError> for CommandError {
    fn from(err: PresetsError) -> Self {
        match err {
            PresetsError::Name => Self::UserPresetName,
            PresetsError::Invalid(detail) => Self::UserPresetInvalid(detail),
            PresetsError::TooLarge => Self::UserPresetTooLarge,
            PresetsError::Full => Self::UserPresetsFull,
            PresetsError::Missing => Self::UserPresetMissing,
            PresetsError::TooNew => Self::UserPresetsTooNew,
            PresetsError::Read(detail) => Self::UserPresetsRead(detail),
            PresetsError::Save(detail) => Self::UserPresetsSave(detail),
        }
    }
}

/// Any JSON value, typed `unknown` in the bindings (the WebView holds the schema).
#[derive(Deserialize, Type)]
#[serde(transparent)]
pub struct Json(#[specta(type = specta_typescript::Unknown)] serde_json::Value);

/// Runs `job` on a blocking thread, so file IO stays off the main thread.
async fn on_store<T: Send + 'static>(
    app: AppHandle,
    job: impl FnOnce(&UserPresets) -> Result<T, PresetsError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(move || job(&app.state::<UserPresets>()))
        .await
        .map_err(|err| CommandError::UserPresetsRead(err.to_string()))?
        .map_err(CommandError::from)
}

/// The backgrounds the user saved, in the order they were first saved.
#[tauri::command]
#[specta::specta]
pub async fn list_user_presets(app: AppHandle) -> Result<Vec<UserPreset>, CommandError> {
    on_store(app, UserPresets::list).await
}

/// Saves a background under a name. With no `id` it is added as a new preset; with
/// an `id` that preset is replaced in place. The background is the JSON of the
/// core `BackgroundSpec`, which the WebView has already validated.
#[tauri::command]
#[specta::specta]
pub async fn save_user_preset(
    app: AppHandle,
    id: Option<String>,
    name: String,
    background: Json,
) -> Result<UserPreset, CommandError> {
    on_store(app, move |store| {
        store.save(id.as_deref(), &name, background.0)
    })
    .await
}

/// Deletes a saved preset. A preset that is already gone is not an error.
#[tauri::command]
#[specta::specta]
pub async fn delete_user_preset(app: AppHandle, id: String) -> Result<(), CommandError> {
    on_store(app, move |store| store.delete(&id)).await
}
