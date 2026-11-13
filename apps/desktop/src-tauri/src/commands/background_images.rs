// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use tauri::{AppHandle, Manager};

use super::{CommandError, image_data_url};
use crate::background_images::{BackgroundImage, BackgroundImages, ImagesError, MAX_IMAGE_MB};

impl From<ImagesError> for CommandError {
    fn from(err: ImagesError) -> Self {
        match err {
            ImagesError::NotSupported => Self::BackgroundImageNotSupported,
            ImagesError::TooLarge => Self::BackgroundImageTooLarge(MAX_IMAGE_MB),
            ImagesError::Full => Self::BackgroundImagesFull,
            ImagesError::Missing => Self::BackgroundImageMissing,
            ImagesError::TooNew => Self::BackgroundImagesTooNew,
            ImagesError::Read(detail) => Self::BackgroundImagesRead(detail),
            ImagesError::Save(detail) => Self::BackgroundImagesSave(detail),
        }
    }
}

/// Runs `job` on a blocking thread, so file IO stays off the main thread.
async fn on_store<T: Send + 'static>(
    app: AppHandle,
    job: impl FnOnce(&BackgroundImages) -> Result<T, ImagesError> + Send + 'static,
) -> Result<T, CommandError> {
    tauri::async_runtime::spawn_blocking(move || job(&app.state::<BackgroundImages>()))
        .await
        .map_err(|err| CommandError::BackgroundImagesRead(err.to_string()))?
        .map_err(CommandError::from)
}

/// The images the user added, in the order they were added.
#[tauri::command]
#[specta::specta]
pub async fn list_background_images(app: AppHandle) -> Result<Vec<BackgroundImage>, CommandError> {
    on_store(app, BackgroundImages::list).await
}

/// Keeps a copy of a picture the user chose. `data` is the base64 of the file's
/// bytes, with no `data:` prefix; only PNG, JPEG and WebP up to 20 MB are kept.
#[tauri::command]
#[specta::specta]
pub async fn add_background_image(
    app: AppHandle,
    name: String,
    data: String,
) -> Result<BackgroundImage, CommandError> {
    on_store(app, move |store| store.add(&name, &data)).await
}

/// A stored image as a `data:` URL.
#[tauri::command]
#[specta::specta]
pub async fn read_background_image(app: AppHandle, id: String) -> Result<String, CommandError> {
    on_store(app, move |store| {
        let image = store.read(&id)?;
        Ok(image_data_url(image.mime, &image.bytes))
    })
    .await
}

/// Deletes a stored image. One that is already gone is not an error.
#[tauri::command]
#[specta::specta]
pub async fn delete_background_image(app: AppHandle, id: String) -> Result<(), CommandError> {
    on_store(app, move |store| store.delete(&id)).await
}
