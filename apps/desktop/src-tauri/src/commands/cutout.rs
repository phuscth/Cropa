//! The two commands behind background removal. The editor sends the model's picture to
//! `apply_cutout` and tells `show_cutout` which cut-out its scene shows, so the history keeps
//! exactly what the scene shows (apply, restore, undo and redo alike).

// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager};

use super::png_data_url;
use crate::cutout::{self, CutoutError};
use crate::editor::EditorImage;
use crate::history::History;

/// A cut-out made for the editor's image.
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppliedCutout {
    /// The name the scene refers to it by, as `mask:<name>`.
    pub name: String,
    /// A `data:` URL of the refined cut-out: the original's pixels with the background removed.
    pub image: String,
}

/// Turns the picture an image model made (`cutout`: base64 PNG, no `data:` prefix) into a
/// cut-out of the editor's image `image_key`, and keeps it in memory under a new name. The
/// history is not written: that follows the scene, through `show_cutout`.
#[tauri::command]
#[specta::specta]
pub async fn apply_cutout(
    app: AppHandle,
    image_key: String,
    cutout: String,
) -> Result<AppliedCutout, CutoutError> {
    tauri::async_runtime::spawn_blocking(move || {
        let editor = app.state::<EditorImage>();
        let current = cutout::current_for(&editor, &image_key)?;
        let png = cutout::make_cutout(&current.png, &cutout)?;
        // The image may have been replaced while the cut-out was computed.
        let name = editor
            .add_cutout(current.generation, png.clone())
            .ok_or(CutoutError::ImageChanged)?;
        Ok(AppliedCutout {
            name,
            image: png_data_url(&png),
        })
    })
    .await
    .map_err(|err| CutoutError::Save(err.to_string()))?
}

/// The cut-out the editor's scene shows now: `name` as returned by `apply_cutout` (or the
/// one the history kept), or `None` for the plain image. A capture kept in the history keeps
/// that cut-out, or none; an image that is not in the history has nothing to keep.
#[tauri::command]
#[specta::specta]
pub async fn show_cutout(
    app: AppHandle,
    image_key: String,
    name: Option<String>,
) -> Result<(), CutoutError> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = cutout::current_for(&app.state::<EditorImage>(), &image_key)?;
        let Some(id) = current.history_id.as_deref() else {
            return Ok(());
        };
        let history = app.state::<History>();
        match name {
            Some(name) => {
                let png = cutout::named_cutout(&current, &name)?;
                history
                    .save_cutout(id, &png)
                    .map(|_| ())
                    .map_err(|err| CutoutError::Save(err.to_string()))
            }
            None => history
                .delete_cutout(id)
                .map_err(|err| CutoutError::Save(err.to_string())),
        }
    })
    .await
    .map_err(|err| CutoutError::Save(err.to_string()))?
}
