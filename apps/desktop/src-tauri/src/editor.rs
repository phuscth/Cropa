//! The image the editor window shows. It lives in memory as PNG bytes: the
//! editor asks for it when it opens and again whenever it changes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use crate::app_windows;

#[derive(Default)]
pub struct EditorImage {
    png: Mutex<Option<Arc<Vec<u8>>>>,
    /// Counts the images the editor has been given, so a file saved from one
    /// image is never replaced by a save of another.
    generation: AtomicU64,
}

impl EditorImage {
    pub fn get(&self) -> Option<Arc<Vec<u8>>> {
        self.png
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Changes every time the editor's image is replaced.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn set(&self, png: Vec<u8>) {
        let mut slot = self.png.lock().unwrap_or_else(PoisonError::into_inner);
        *slot = Some(Arc::new(png));
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// The editor has another image to show.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct EditorImageChanged;

/// Make `png` the editor's image and bring the editor to the front.
pub fn open<R: Runtime>(app: &AppHandle<R>, png: Vec<u8>) {
    app.state::<EditorImage>().set(png);
    if let Err(err) = EditorImageChanged.emit(app) {
        log::warn!("could not emit the editor image change: {err}");
    }
    app_windows::show(app, app_windows::EDITOR);
}
