//! The image the editor view shows. It lives in memory as PNG bytes, with the
//! time it was captured: the editor asks for them when it opens and again
//! whenever the image changes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use crate::main_window::{self, MainView};

/// The editor's image and when it was captured.
#[derive(Clone)]
pub struct Current {
    pub png: Arc<Vec<u8>>,
    /// Milliseconds since the Unix epoch; `None` when the capture time is unknown.
    pub captured_at: Option<f64>,
    /// The capture's id in the history, when it is kept there.
    pub history_id: Option<String>,
}

#[derive(Default)]
pub struct EditorImage {
    current: Mutex<Option<Current>>,
    /// Counts the images the editor has been given, so a file saved from one
    /// image is never replaced by a save of another.
    generation: AtomicU64,
}

impl EditorImage {
    pub fn get(&self) -> Option<Current> {
        self.current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Changes every time the editor's image is replaced.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn set(&self, png: Vec<u8>, captured_at: Option<f64>, history_id: Option<String>) {
        let mut slot = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        *slot = Some(Current {
            png: Arc::new(png),
            captured_at,
            history_id,
        });
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// The editor has another image to show.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct EditorImageChanged;

/// Make `png` the editor's image, captured at `captured_at` (milliseconds since
/// the Unix epoch, if known) and kept in the history as `history_id` (if it is), and
/// bring the editor to the front.
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    png: Vec<u8>,
    captured_at: Option<f64>,
    history_id: Option<String>,
) {
    app.state::<EditorImage>().set(png, captured_at, history_id);
    if let Err(err) = EditorImageChanged.emit(app) {
        log::warn!("could not emit the editor image change: {err}");
    }
    main_window::show_main(app, MainView::Editor);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capture_time_comes_back_with_the_image() {
        let editor = EditorImage::default();
        assert!(editor.get().is_none());

        editor.set(
            vec![1, 2, 3],
            Some(1_700_000_000_123.0),
            Some("1700000000123".into()),
        );
        let current = editor.get().expect("an image was set");
        assert_eq!(*current.png, vec![1, 2, 3]);
        assert_eq!(current.captured_at, Some(1_700_000_000_123.0));
        assert_eq!(current.history_id.as_deref(), Some("1700000000123"));

        let generation = editor.generation();
        editor.set(vec![4], None, None);
        let current = editor.get().expect("an image was set");
        assert_eq!(current.captured_at, None);
        assert_eq!(current.history_id, None);
        assert_eq!(editor.generation(), generation + 1);
    }
}
