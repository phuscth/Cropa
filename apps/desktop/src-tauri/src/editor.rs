//! The image the editor view shows. It lives in memory as PNG bytes, with the
//! time it was captured: the editor asks for them when it opens and again
//! whenever the image changes.

use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use base64::Engine;
use image::{ImageFormat, ImageReader, Limits, RgbaImage};
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

/// The longest side of an imported image, in pixels. Mirrors `MAX_IMPORT_SIDE` in
/// `import-image.ts`.
pub const MAX_IMPORT_SIDE: u32 = 16_384;
/// The most pixels an imported image may have. Mirrors `MAX_IMPORT_PIXELS` in
/// `import-image.ts`.
pub const MAX_IMPORT_PIXELS: u64 = 50_000_000;
/// The most bytes a PNG sent for import may have once decoded from base64.
const MAX_IMPORT_PNG_BYTES: usize = 256 * 1024 * 1024;
/// The most memory the PNG decoder may allocate for one import.
const MAX_IMPORT_ALLOC: u64 = 512 * 1024 * 1024;
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ImportError {
    #[error("the data is not a PNG picture: {0}")]
    Unreadable(String),
    #[error(
        "the picture is over {MAX_IMPORT_SIDE} pixels on a side or {MAX_IMPORT_PIXELS} pixels in all"
    )]
    TooLarge,
}

/// Check and decode a PNG the WebView sent as base64 (no `data:` prefix). Returns the
/// PNG bytes, which the editor keeps as they are, and the decoded pixels.
///
/// The WebView has already decoded the picture and checked its size; this checks the
/// header before it decodes, so a bad call cannot make Rust allocate a huge buffer.
pub fn decode_import(data: &str) -> Result<(Vec<u8>, RgbaImage), ImportError> {
    if data.len() > MAX_IMPORT_PNG_BYTES / 3 * 4 + 4 {
        return Err(ImportError::TooLarge);
    }
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|err| ImportError::Unreadable(err.to_string()))?;
    if !png.starts_with(&PNG_MAGIC) {
        return Err(ImportError::Unreadable(
            "the PNG signature is missing".into(),
        ));
    }

    let reader = || ImageReader::with_format(Cursor::new(&png), ImageFormat::Png);
    let (width, height) = reader()
        .into_dimensions()
        .map_err(|err| ImportError::Unreadable(err.to_string()))?;
    if width > MAX_IMPORT_SIDE
        || height > MAX_IMPORT_SIDE
        || u64::from(width) * u64::from(height) > MAX_IMPORT_PIXELS
    {
        return Err(ImportError::TooLarge);
    }

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMPORT_SIDE);
    limits.max_image_height = Some(MAX_IMPORT_SIDE);
    limits.max_alloc = Some(MAX_IMPORT_ALLOC);
    let mut reader = reader();
    reader.limits(limits);
    let rgba = reader
        .decode()
        .map_err(|err| ImportError::Unreadable(err.to_string()))?
        .into_rgba8();
    Ok((png, rgba))
}

#[cfg(test)]
mod tests {
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder, Rgba};

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
    fn png_of(width: u32, height: u32, color: ExtendedColorType, pixels: &[u8]) -> String {
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(pixels, width, height, color)
            .expect("the test image encodes");
        base64::engine::general_purpose::STANDARD.encode(png)
    }

    fn grey_png(width: u32, height: u32) -> String {
        let pixels = vec![0_u8; usize::try_from(u64::from(width) * u64::from(height)).unwrap()];
        png_of(width, height, ExtendedColorType::L8, &pixels)
    }

    #[test]
    fn a_valid_png_decodes_with_its_bytes_kept() {
        let data = png_of(
            2,
            1,
            ExtendedColorType::Rgba8,
            &[1, 2, 3, 255, 4, 5, 6, 128],
        );
        let (png, rgba) = decode_import(&data).expect("a small PNG imports");
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(&png),
            data,
            "the bytes are the ones sent"
        );
        assert_eq!((rgba.width(), rgba.height()), (2, 1));
        assert_eq!(*rgba.get_pixel(1, 0), Rgba([4, 5, 6, 128]));
    }

    #[test]
    fn data_that_is_not_a_png_is_unreadable() {
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let jpeg = encode(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0]);
        let text = encode(b"not a picture");
        let truncated = encode(&PNG_MAGIC);
        for data in [jpeg, text, truncated, "***not base64***".to_owned()] {
            assert!(
                matches!(decode_import(&data), Err(ImportError::Unreadable(_))),
                "{data}"
            );
        }
    }

    #[test]
    fn a_picture_over_the_limits_is_too_large() {
        assert_eq!(
            decode_import(&grey_png(MAX_IMPORT_SIDE + 1, 1)).unwrap_err(),
            ImportError::TooLarge,
            "one side over the limit"
        );
        assert_eq!(
            decode_import(&grey_png(10_000, 5_001)).unwrap_err(),
            ImportError::TooLarge,
            "more pixels than the cap"
        );
        assert!(decode_import(&grey_png(MAX_IMPORT_SIDE, 1)).is_ok());
    }
}
