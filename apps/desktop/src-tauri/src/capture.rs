//! Region capture: the capture key or tray item freezes every monitor, the
//! platform overlay lets the user drag a region over the frozen picture, and
//! the cropped pixels go to the clipboard. Esc leaves the clipboard untouched.
//!
//! The work runs on its own thread because the overlay pumps its own message
//! loop and must never share the UI event loop.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use image::RgbaImage;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_specta::Event;

use crate::i18n::{CaptureFailure, Lang, capture_failed_text, capture_text};
use crate::platform::{self, MonitorInfo, Platform, Selection};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum CaptureSource {
    Hotkey,
    Tray,
}

#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequested {
    pub source: CaptureSource,
}

/// Set while a capture runs, so a second key press cannot capture the overlay.
static BUSY: AtomicBool = AtomicBool::new(false);

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
    let spawned = std::thread::Builder::new()
        .name("cropa-capture".into())
        .spawn(move || {
            let _guard = guard;
            run(pressed);
        });
    if let Err(err) = spawned {
        log::warn!("could not start the capture thread: {err}");
    }
}

fn run(pressed: Instant) {
    let platform = platform::current();

    let shots = match platform.capture_all() {
        Ok(shots) => shots,
        Err(err) => return fail(&platform, CaptureFailure::Capture, &err.to_string()),
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
            return;
        }
        Err(err) => return fail(&platform, CaptureFailure::Overlay, &err.to_string()),
    };

    let Some(image) = crop(&shots, &selection) else {
        log::warn!("the selection does not fit its capture; nothing was copied");
        return;
    };
    if let Err(err) = platform.copy_image(&image) {
        return fail(&platform, CaptureFailure::Clipboard, &err.to_string());
    }
    log::info!(
        "region {}×{} copied to the clipboard {} ms after mouse release",
        image.width(),
        image.height(),
        selection.released_at.elapsed().as_millis()
    );
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
    use crate::platform::PixelRect;
    use crate::platform::geometry::{Point, crop_rect};

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
            released_at: Instant::now(),
        };

        let image = crop(&shots, &selection).expect("the selection fits");

        assert_eq!((image.width(), image.height()), (500, 300));
        assert_eq!(*image.get_pixel(0, 0), pixel_at(400, 200));
        assert_eq!(*image.get_pixel(499, 299), pixel_at(899, 499));
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
            released_at: Instant::now(),
        };

        assert!(crop(&shots, &selection(0, 95, 10)).is_none());
        assert!(crop(&shots, &selection(1, 0, 10)).is_none());
        assert!(crop(&shots, &selection(0, 90, 10)).is_some());
    }
}
