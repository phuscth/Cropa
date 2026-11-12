// Tauri commands receive `State`, `AppHandle` and arguments by value; the
// macro cannot take references.
#![allow(clippy::needless_pass_by_value)]

use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{CommandError, settings::persist};
use crate::editor::EditorImage;
use crate::export::{
    ExportError, ExportFormat, SavedFiles, capture_file_stem, decode_data_url, local_capture_time,
    overwrite_file, sanitize_file_stem, write_new_file,
};
use crate::i18n::{self, Lang};
use crate::platform::{self, OwnerWindow, Platform, SaveFileType};
use crate::state::AppState;

/// The widest or tallest image the clipboard copy decodes, and the memory it
/// may take.
const MAX_DECODE_SIDE: u32 = 32_767;
const MAX_DECODE_ALLOC: u64 = 1024 * 1024 * 1024;

/// A file saved in this run. The WebView refers to it by `id`; `path` is only
/// for display.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub id: u32,
    pub path: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveOutcome {
    Saved { file: SavedFile },
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveAsChoice {
    Chosen {
        token: u32,
        format: ExportFormat,
        #[serde(rename = "fileName")]
        file_name: String,
    },
    Cancelled,
}

impl From<ExportError> for CommandError {
    fn from(err: ExportError) -> Self {
        match err {
            ExportError::Invalid => Self::ExportInvalid,
            ExportError::TooLarge(mb) => Self::ExportTooLarge(mb),
        }
    }
}

fn save_file_error(err: &io::Error) -> CommandError {
    CommandError::SaveFile(err.to_string())
}

fn dialog_error(err: &platform::PlatformError) -> CommandError {
    CommandError::SaveDialog(err.to_string())
}

fn join_error(err: &tauri::Error) -> CommandError {
    CommandError::SaveFile(err.to_string())
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn saved_file(id: u32, path: &Path) -> SavedFile {
    SavedFile {
        id,
        path: path.display().to_string(),
        file_name: file_name_of(path),
    }
}

/// The native handle of the window that called a command, to own its dialogs.
pub(crate) fn owner_of(window: &WebviewWindow) -> Option<OwnerWindow> {
    #[cfg(windows)]
    {
        window.hwnd().ok().map(|hwnd| OwnerWindow(hwnd.0 as isize))
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

fn save_folder(app: &AppHandle) -> Option<PathBuf> {
    app.state::<AppState>().lock().settings.save_folder.clone()
}

/// Save the image to the save folder without asking, or ask for the folder the
/// first time (and when the folder is gone or refuses writes).
fn quick_save_blocking(
    app: &AppHandle,
    owner: Option<OwnerWindow>,
    bytes: &[u8],
    format: ExportFormat,
    captured_at: Option<f64>,
    session_file: Option<u32>,
) -> Result<SaveOutcome, CommandError> {
    let saved_files = app.state::<SavedFiles>();
    let _saving = saved_files.hold_save_lock();
    let generation = app.state::<EditorImage>().generation();

    // The same image saved again replaces its earlier quick save. The id is only
    // looked up: a path never comes from the WebView.
    if let Some(id) = session_file
        && let Some(entry) = saved_files.quick_entry(id, format, generation)
        && entry.path.parent().is_some_and(Path::is_dir)
    {
        overwrite_file(&entry.path, bytes).map_err(|err| save_file_error(&err))?;
        return Ok(SaveOutcome::Saved {
            file: saved_file(id, &entry.path),
        });
    }

    let stem = capture_file_stem(local_capture_time(captured_at));
    let ext = format.extension();
    let folder = save_folder(app).filter(|dir| dir.is_dir());

    if let Some(dir) = &folder {
        match write_new_file(dir, &stem, ext, bytes) {
            Ok(path) => return Ok(registered(&saved_files, &path, format, generation)),
            // A folder that refuses writes is treated like a missing one.
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem
                ) => {}
            Err(err) => return Err(save_file_error(&err)),
        }
    }

    let text = i18n::save_dialog_text(Lang::detect());
    let picked = platform::current()
        .pick_folder(owner, text.pick_folder_title, folder.as_deref())
        .map_err(|err| dialog_error(&err))?;
    let Some(dir) = picked else {
        return Ok(SaveOutcome::Cancelled);
    };
    let path = write_new_file(&dir, &stem, ext, bytes).map_err(|err| save_file_error(&err))?;
    // The file is saved; failing to remember the folder only means Cropa asks again.
    if let Err(err) = persist(&app.state::<AppState>(), |s| s.save_folder = Some(dir)) {
        log::warn!("could not remember the save folder: {err}");
    }
    Ok(registered(&saved_files, &path, format, generation))
}

fn registered(
    saved_files: &SavedFiles,
    path: &Path,
    format: ExportFormat,
    generation: u64,
) -> SaveOutcome {
    let id = saved_files.register(path.to_path_buf(), format, true, generation);
    SaveOutcome::Saved {
        file: saved_file(id, path),
    }
}

/// Ctrl+S: save the rendered image (a `data:` URL of `format`) to the save
/// folder, named after the capture time. `session_file` is the id of this
/// image's earlier quick save, which is then replaced instead of adding a copy.
#[tauri::command]
#[specta::specta]
pub async fn quick_save(
    app: AppHandle,
    window: WebviewWindow,
    image: String,
    format: ExportFormat,
    captured_at: Option<f64>,
    session_file: Option<u32>,
) -> Result<SaveOutcome, CommandError> {
    let owner = owner_of(&window);
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_data_url(&image, format)?;
        quick_save_blocking(&app, owner, &bytes, format, captured_at, session_file)
    })
    .await
    .map_err(|err| join_error(&err))?
}

/// Show the Save as dialog. The file is written by [`write_save_as`] once the
/// WebView has encoded the format the user picked in the dialog.
#[tauri::command]
#[specta::specta]
pub async fn choose_save_as_path(
    app: AppHandle,
    window: WebviewWindow,
    suggested_name: String,
    format: ExportFormat,
) -> Result<SaveAsChoice, CommandError> {
    let owner = owner_of(&window);
    tauri::async_runtime::spawn_blocking(move || {
        let saved_files = app.state::<SavedFiles>();
        let text = i18n::save_dialog_text(Lang::detect());
        let labels = [text.png, text.jpeg, text.webp];
        let types: Vec<SaveFileType<'_>> = ExportFormat::ALL
            .iter()
            .zip(labels)
            .map(|(format, label)| SaveFileType {
                label,
                extension: format.extension(),
            })
            .collect();
        let initial = ExportFormat::ALL
            .iter()
            .position(|candidate| *candidate == format)
            .unwrap_or(0);
        let file_name = format!(
            "{}.{}",
            sanitize_file_stem(&suggested_name),
            format.extension()
        );
        let start_in = saved_files.last_save_as_dir().or_else(|| save_folder(&app));

        let picked = platform::current()
            .pick_save_path(
                owner,
                text.save_as_title,
                &types,
                initial,
                &file_name,
                start_in.as_deref(),
            )
            .map_err(|err| dialog_error(&err))?;
        let Some((path, type_index)) = picked else {
            return Ok(SaveAsChoice::Cancelled);
        };

        // A typed image extension decides the format; otherwise the file type
        // selected in the dialog does. The path stays exactly as the dialog confirmed it.
        let named = path
            .extension()
            .and_then(|ext| ext.to_str())
            .and_then(ExportFormat::from_extension);
        let chosen = if let Some(named) = named {
            named
        } else {
            ExportFormat::ALL.get(type_index).copied().unwrap_or(format)
        };

        if let Some(dir) = path.parent() {
            saved_files.set_last_save_as_dir(dir.to_path_buf());
        }
        let file_name = file_name_of(&path);
        let token = saved_files.set_pending_save_as(path, chosen);
        Ok(SaveAsChoice::Chosen {
            token,
            format: chosen,
            file_name,
        })
    })
    .await
    .map_err(|err| join_error(&err))?
}

/// Write the image to the destination picked by [`choose_save_as_path`]. The
/// dialog already asked before replacing a file, so an existing one is
/// replaced.
#[tauri::command]
#[specta::specta]
pub async fn write_save_as(
    app: AppHandle,
    token: u32,
    image: String,
) -> Result<SavedFile, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let saved_files = app.state::<SavedFiles>();
        let _saving = saved_files.hold_save_lock();
        let (path, format) = saved_files
            .take_pending_save_as(token)
            .ok_or(CommandError::SaveAsExpired)?;
        let bytes = decode_data_url(&image, format)?;
        overwrite_file(&path, &bytes).map_err(|err| save_file_error(&err))?;
        let id = saved_files.register(
            path.clone(),
            format,
            false,
            app.state::<EditorImage>().generation(),
        );
        Ok(saved_file(id, &path))
    })
    .await
    .map_err(|err| join_error(&err))?
}

fn decode_png_for_clipboard(bytes: &[u8]) -> Result<image::RgbaImage, CommandError> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODE_SIDE);
    limits.max_image_height = Some(MAX_DECODE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    let mut reader =
        image::ImageReader::with_format(io::Cursor::new(bytes), image::ImageFormat::Png);
    reader.limits(limits);
    reader
        .decode()
        .map(image::DynamicImage::into_rgba8)
        .map_err(|_| CommandError::ExportInvalid)
}

/// Put the rendered image (a PNG `data:` URL) on the clipboard.
#[tauri::command]
#[specta::specta]
pub async fn copy_rendered_image(app: AppHandle, image: String) -> Result<(), CommandError> {
    let exclude = app
        .state::<AppState>()
        .lock()
        .settings
        .exclude_from_clipboard_history;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_data_url(&image, ExportFormat::Png)?;
        let rgba = decode_png_for_clipboard(&bytes)?;
        platform::current()
            .copy_image(&rgba, exclude)
            .map_err(|err| CommandError::Clipboard(err.to_string()))
    })
    .await
    .map_err(|err| CommandError::Clipboard(err.to_string()))?
}

/// Show a file saved in this run in its folder, selected.
#[tauri::command]
#[specta::specta]
pub async fn reveal_saved_file(app: AppHandle, id: u32) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = app
            .state::<SavedFiles>()
            .get(id)
            .filter(|entry| entry.path.is_file())
            .ok_or(CommandError::SavedFileGone)?;
        platform::current()
            .reveal_file(&entry.path)
            .map_err(|err| CommandError::OpenFolder(err.to_string()))
    })
    .await
    .map_err(|err| CommandError::OpenFolder(err.to_string()))?
}
