// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use serde::Deserialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};

use super::CommandError;
use super::export::{dialog_error, file_name_of, join_error, save_file_error, save_folder};
use crate::export::{SavedFiles, overwrite_file, sanitize_file_stem};
use crate::i18n::{self, Lang};
use crate::platform::{self, OwnerWindow, Platform, SaveFileType};
use crate::presets::{MAX_BACKGROUND_BYTES, PresetsError, UserPreset, UserPresets};

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

/// A preset file is one small JSON object; anything else is refused before the
/// dialog is shown.
fn check_preset_file_text(text: &str) -> Result<(), CommandError> {
    if text.len() > MAX_BACKGROUND_BYTES {
        return Err(CommandError::UserPresetTooLarge);
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(_)) => Ok(()),
        Ok(_) => Err(CommandError::UserPresetInvalid(
            "the file is not a JSON object".to_owned(),
        )),
        Err(err) => Err(CommandError::UserPresetInvalid(err.to_string())),
    }
}

/// Exports a preset: shows a Save dialog for a `.json` file and writes `text`
/// there. `None` when the user cancels. The text is the preset file the WebView
/// built.
#[tauri::command]
#[specta::specta]
pub async fn save_preset_file(
    app: AppHandle,
    window: WebviewWindow,
    suggested_name: String,
    text: String,
) -> Result<Option<String>, CommandError> {
    check_preset_file_text(&text)?;
    let owner = OwnerWindow::of(&window);
    tauri::async_runtime::spawn_blocking(move || {
        let saved_files = app.state::<SavedFiles>();
        let dialog = i18n::save_dialog_text(Lang::detect());
        let types = [SaveFileType {
            label: dialog.preset_file,
            extension: "json",
        }];
        let file_name = format!("{}.json", sanitize_file_stem(&suggested_name));
        let start_in = saved_files.last_save_as_dir().or_else(|| save_folder(&app));
        let picked = platform::current()
            .pick_save_path(
                owner,
                dialog.preset_title,
                &types,
                0,
                &file_name,
                start_in.as_deref(),
            )
            .map_err(|err| dialog_error(&err))?;
        let Some((path, _)) = picked else {
            return Ok(None);
        };
        // The dialog already asked before replacing an existing file.
        overwrite_file(&path, text.as_bytes()).map_err(|err| save_file_error(&err))?;
        if let Some(dir) = path.parent() {
            saved_files.set_last_save_as_dir(dir.to_path_buf());
        }
        Ok(Some(file_name_of(&path)))
    })
    .await
    .map_err(|err| join_error(&err))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_small_object() {
        assert!(check_preset_file_text(r#"{"version":1}"#).is_ok());
    }

    #[test]
    fn rejects_text_over_the_limit() {
        let text = format!(r#"{{"name":"{}"}}"#, "a".repeat(MAX_BACKGROUND_BYTES));
        assert!(matches!(
            check_preset_file_text(&text),
            Err(CommandError::UserPresetTooLarge)
        ));
    }

    #[test]
    fn rejects_invalid_json_and_arrays() {
        assert!(matches!(
            check_preset_file_text("{not json"),
            Err(CommandError::UserPresetInvalid(_))
        ));
        assert!(matches!(
            check_preset_file_text("[1, 2]"),
            Err(CommandError::UserPresetInvalid(_))
        ));
    }
}
