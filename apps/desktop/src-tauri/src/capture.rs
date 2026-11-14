//! Screen capture: the capture key or tray item freezes every monitor, the
//! platform overlay lets the user drag a region, pick a window or pick a whole
//! monitor on the frozen picture, and the cropped pixels go to the clipboard. Esc leaves the clipboard untouched.
//! A small floating preview of the capture then waits in the screen corner
//! until the user opens it in the editor, dismisses it, or captures again.
//!
//! The work runs on its own thread because the overlay pumps its own message
//! loop and must never share the UI event loop.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Instant, SystemTime};

use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, RgbaImage};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use crate::editor;
use crate::history::{History, HistoryChanged, epoch_millis, history_id_at};
use crate::i18n::{CaptureFailure, Lang, capture_failed_text, capture_text};
use crate::platform::{
    self, MonitorInfo, Platform, PreviewAction, PreviewCloser, PreviewHandle, Selection,
};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum CaptureSource {
    Hotkey,
    Tray,
    /// The capture button of the main window's empty editor.
    Menu,
}

#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequested {
    pub source: CaptureSource,
}

/// Set while a capture runs, so a second key press cannot capture the overlay.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Takes down the preview that is on screen, if any.
static PREVIEW: Mutex<Option<PreviewCloser>> = Mutex::new(None);

/// A preview on screen, with the capture it shows.
struct PendingPreview {
    actions: Receiver<PreviewAction>,
    image: Arc<RgbaImage>,
    captured_at: SystemTime,
    /// The history id of this capture when it is being saved to the history.
    history_id: Option<String>,
}

/// Clears [`BUSY`] when dropped, including on a panic or an early return.
struct BusyGuard;

impl BusyGuard {
    fn acquire() -> Option<Self> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

pub fn request<R: Runtime>(app: &AppHandle<R>, source: CaptureSource) {
    log::info!("capture requested from {source:?}");
    let Some(guard) = BusyGuard::acquire() else {
        log::info!("capture already in progress");
        return;
    };
    if let Err(err) = (CaptureRequested { source }).emit(app) {
        log::warn!("could not emit capture request: {err}");
    }
    let pressed = Instant::now();
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("cropa-capture".into())
        .spawn(move || {
            let pending = run(&app, pressed);
            // A new capture can start while the preview waits for a choice.
            drop(guard);
            if let Some(pending) = pending {
                wait_for_choice(&app, pending);
            }
        });
    if let Err(err) = spawned {
        log::warn!("could not start the capture thread: {err}");
    }
}

fn run<R: Runtime>(app: &AppHandle<R>, pressed: Instant) -> Option<PendingPreview> {
    // The old preview must be gone before the screen is captured, or it would
    // be in the new picture. This is also how a new capture replaces it.
    if let Some(closer) = PREVIEW
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
    {
        closer.close();
    }

    let platform = platform::current();

    let shots = match platform.capture_all() {
        Ok(shots) => shots,
        Err(err) => {
            fail(&platform, CaptureFailure::Capture, &err.to_string());
            return None;
        }
    };
    log::info!(
        "captured {} monitor(s) in {} ms after the key press",
        shots.len(),
        pressed.elapsed().as_millis()
    );

    let selection = match platform.select_region(&shots) {
        Ok(Some(selection)) => selection,
        Ok(None) => {
            log::info!("capture cancelled");
            return None;
        }
        Err(err) => {
            fail(&platform, CaptureFailure::Overlay, &err.to_string());
            return None;
        }
    };

    let Some(image) = crop(&shots, &selection) else {
        log::warn!("the selection does not fit its capture; nothing was copied");
        return None;
    };
    let (save_history, exclude_from_history) = {
        let state = app.state::<AppState>();
        let inner = state.lock();
        (
            inner.settings.save_history,
            inner.settings.exclude_from_clipboard_history,
        )
    };
    if let Err(err) = platform.copy_image(&image, exclude_from_history) {
        fail(&platform, CaptureFailure::Clipboard, &err.to_string());
        return None;
    }
    log::info!(
        "{} {}×{} copied to the clipboard {} ms after mouse release",
        selection.mode.log_name(),
        image.width(),
        image.height(),
        selection.released_at.elapsed().as_millis()
    );

    let image = Arc::new(image);
    // The history entry and the editor both name this capture by this time.
    let captured_at = SystemTime::now();
    if save_history {
        save_to_history(app, Arc::clone(&image), captured_at);
    }

    let monitor = &shots.get(selection.monitor)?.0;
    match platform.show_preview(&image, monitor) {
        Ok(PreviewHandle { actions, closer }) => {
            log::info!(
                "preview shown {} ms after mouse release",
                selection.released_at.elapsed().as_millis()
            );
            // Stored while the busy flag is still held, so the next capture
            // always finds and closes this preview.
            *PREVIEW.lock().unwrap_or_else(PoisonError::into_inner) = Some(closer);
            Some(PendingPreview {
                actions,
                image,
                captured_at,
                history_id: save_history.then(|| history_id_at(captured_at)),
            })
        }
        Err(err) => {
            // The clipboard already holds the capture.
            log::warn!("could not show the preview: {err}");
            None
        }
    }
}

/// Wait for the user's choice on the preview. It never touches the clipboard.
fn wait_for_choice<R: Runtime>(app: &AppHandle<R>, pending: PendingPreview) {
    let PendingPreview {
        actions,
        image,
        captured_at,
        history_id,
    } = pending;
    // A disconnect means the preview was closed another way: nothing to do.
    if actions.recv() == Ok(PreviewAction::Edit) {
        match encode_png(&image) {
            Ok(png) => editor::open(app, png, Some(epoch_millis(captured_at)), history_id),
            Err(err) => log::warn!("could not open the capture in the editor: {err}"),
        }
    }
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, image::ImageError> {
    let mut png = Vec::new();
    PngEncoder::new(&mut png).write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        ExtendedColorType::Rgba8,
    )?;
    Ok(png)
}

/// Keep the capture in the history folder. It runs on its own thread, after
/// the clipboard already holds the capture, and a failure is only logged.
fn save_to_history<R: Runtime>(app: &AppHandle<R>, image: Arc<RgbaImage>, captured_at: SystemTime) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("cropa-history".into())
        .spawn(move || {
            let started = Instant::now();
            match app.state::<History>().save(&image, captured_at) {
                Ok(_) => {
                    log::info!(
                        "capture saved to history in {} ms",
                        started.elapsed().as_millis()
                    );
                    if let Err(err) = HistoryChanged.emit(&app) {
                        log::warn!("could not emit the history change: {err}");
                    }
                }
                Err(err) => log::warn!("could not save the capture to history: {err}"),
            }
        });
    if let Err(err) = spawned {
        log::warn!("could not start the history thread: {err}");
    }
}

/// Log the failure and tell the user what happened.
fn fail(platform: &impl Platform, failure: CaptureFailure, detail: &str) {
    log::warn!("capture failed ({failure:?}): {detail}");
    let lang = Lang::detect();
    let notice = capture_failed_text(lang, failure, detail);
    if let Err(err) = platform.show_warning(capture_text(lang).title, &notice) {
        log::warn!("could not show the capture notice: {err}");
    }
}

/// The selected pixels, or `None` when the monitor index or the rectangle is
/// outside the capture.
fn crop(shots: &[(MonitorInfo, RgbaImage)], selection: &Selection) -> Option<RgbaImage> {
    let (_, capture) = shots.get(selection.monitor)?;
    let rect = selection.rect;
    let right = rect.x.checked_add(rect.width)?;
    let bottom = rect.y.checked_add(rect.height)?;
    if rect.width == 0 || rect.height == 0 || right > capture.width() || bottom > capture.height() {
        return None;
    }
    Some(image::imageops::crop_imm(capture, rect.x, rect.y, rect.width, rect.height).to_image())
}

#[cfg(test)]
mod tests {
    use image::Rgba;

    use super::*;
    use crate::platform::geometry::{DesktopRect, Point, crop_rect};
    use crate::platform::window_pick::window_on_monitor;
    use crate::platform::{CaptureMode, PixelRect};

    fn monitor(x: i32, y: i32, width: u32, height: u32) -> MonitorInfo {
        MonitorInfo {
            id: 1,
            name: "test".into(),
            x,
            y,
            width,
            height,
            scale_factor: 1.25,
            is_primary: false,
        }
    }

    /// Every pixel holds its own coordinates.
    fn coordinate_image(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, pixel_at)
    }

    fn pixel_at(x: u32, y: u32) -> Rgba<u8> {
        let [x_low, x_high, ..] = x.to_le_bytes();
        let [y_low, y_high, ..] = y.to_le_bytes();
        Rgba([x_low, x_high, y_low, y_high])
    }

    #[test]
    fn the_crop_covers_exactly_the_dragged_pixels() {
        let info = monitor(-2400, -300, 2400, 1350);
        let shots = vec![(info.clone(), coordinate_image(2400, 1350))];
        let rect = crop_rect(
            &info,
            2400,
            1350,
            Point { x: -2000, y: -100 },
            Point { x: -1501, y: 199 },
        )
        .expect("the drag has an area");
        let selection = Selection {
            monitor: 0,
            rect,
            mode: CaptureMode::Region,
            released_at: Instant::now(),
        };

        let image = crop(&shots, &selection).expect("the selection fits");

        assert_eq!((image.width(), image.height()), (500, 300));
        assert_eq!(*image.get_pixel(0, 0), pixel_at(400, 200));
        assert_eq!(*image.get_pixel(499, 299), pixel_at(899, 499));
    }

    #[test]
    fn a_window_crop_covers_exactly_the_window_on_that_monitor() {
        let info = monitor(-2400, -300, 2400, 1350);
        let shots = vec![(info.clone(), coordinate_image(2400, 1350))];
        // A window that hangs over the monitor's right edge.
        let window = DesktopRect {
            x: -400,
            y: -200,
            width: 600,
            height: 250,
        };
        let (_, rect) = window_on_monitor(window, &info, 2400, 1350).expect("it reaches");
        let selection = Selection {
            monitor: 0,
            rect,
            mode: CaptureMode::Window,
            released_at: Instant::now(),
        };

        let image = crop(&shots, &selection).expect("the selection fits");

        assert_eq!((image.width(), image.height()), (400, 250));
        assert_eq!(*image.get_pixel(0, 0), pixel_at(2000, 100));
        assert_eq!(*image.get_pixel(399, 249), pixel_at(2399, 349));
    }

    #[test]
    fn a_selection_outside_the_capture_is_refused() {
        let info = monitor(0, 0, 100, 100);
        let shots = vec![(info, coordinate_image(100, 100))];
        let selection = |monitor, x, width| Selection {
            monitor,
            rect: PixelRect {
                x,
                y: 0,
                width,
                height: 10,
            },
            mode: CaptureMode::Region,
            released_at: Instant::now(),
        };

        assert!(crop(&shots, &selection(0, 95, 10)).is_none());
        assert!(crop(&shots, &selection(1, 0, 10)).is_none());
        assert!(crop(&shots, &selection(0, 90, 10)).is_some());
    }
}
