//! The image the editor window shows. It lives in memory as PNG bytes: the
//! editor asks for it when it opens and again whenever it changes.

use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use crate::app_windows;

#[derive(Default)]
pub struct EditorImage(Mutex<Option<Arc<Vec<u8>>>>);

impl EditorImage {
    pub fn get(&self) -> Option<Arc<Vec<u8>>> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set(&self, png: Vec<u8>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(png));
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
