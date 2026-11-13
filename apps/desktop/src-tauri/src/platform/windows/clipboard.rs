//! Put an image on the Windows clipboard as a registered "PNG" format (lossless,
//! understood by modern apps) and as a classic bitmap (`CF_DIB`, understood by
//! everything else).

use std::time::Duration;

use ::windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use ::windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use ::windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use ::windows::Win32::System::Ole::CF_DIB;
use ::windows::core::w;
use image::ImageEncoder;
use image::codecs::png::PngEncoder;

use super::super::{PlatformError, Result, RgbaImage};

const OPEN_ATTEMPTS: u32 = 10;
const OPEN_RETRY_DELAY: Duration = Duration::from_millis(10);

#[allow(clippy::needless_pass_by_value)]
fn os_error(err: impl ToString) -> PlatformError {
    PlatformError::Os(err.to_string())
}

/// Registered formats that tell Windows clipboard history, cloud sync and
/// clipboard monitors to leave the content alone. Each holds a DWORD `0`.
const PRIVACY_FORMATS: [::windows::core::PCWSTR; 3] = [
    w!("ExcludeClipboardContentFromMonitorProcessing"),
    w!("CanIncludeInClipboardHistory"),
    w!("CanUploadToCloudClipboard"),
];

pub fn copy_image(image: &RgbaImage, exclude_from_history: bool) -> Result<()> {
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(os_error)?;
    let dib = dib_from_rgba(image);

    let _clipboard = Clipboard::open()?;
    // SAFETY: the clipboard is open and owned by this thread through the guard.
    unsafe { EmptyClipboard() }.map_err(os_error)?;
    // The privacy flags go first, so a failure later never leaves an image on
    // the clipboard without them.
    if exclude_from_history {
        for name in PRIVACY_FORMATS {
            // SAFETY: the format names are null-terminated literals.
            let format = unsafe { RegisterClipboardFormatW(name) };
            if format == 0 {
                return Err(os_error(::windows::core::Error::from_thread()));
            }
            set_data(format, &0u32.to_le_bytes())?;
        }
    }
    // SAFETY: the format name is a null-terminated literal.
    let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
    if png_format == 0 {
        return Err(os_error(::windows::core::Error::from_thread()));
    }
    set_data(png_format, &png)?;
    set_data(u32::from(CF_DIB.0), &dib)
}

/// The clipboard, open for this thread until dropped.
struct Clipboard;

impl Clipboard {
    /// Another app may hold the clipboard for a moment, so retry briefly.
    fn open() -> Result<Self> {
        let mut last = None;
        for attempt in 0..OPEN_ATTEMPTS {
            // SAFETY: no owner window is needed to open the clipboard for writing.
            match unsafe { OpenClipboard(None) } {
                Ok(()) => return Ok(Self),
                Err(err) => last = Some(err),
            }
            if attempt + 1 < OPEN_ATTEMPTS {
                std::thread::sleep(OPEN_RETRY_DELAY);
            }
        }
        Err(os_error(last.map_or_else(
            || "the clipboard did not open".to_owned(),
            |err| err.to_string(),
        )))
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) {
        // SAFETY: this thread opened the clipboard in `open`.
        if let Err(err) = unsafe { CloseClipboard() } {
            log::warn!("could not close the clipboard: {err}");
        }
    }
}

/// Copy `bytes` into movable global memory and hand it to the clipboard.
fn set_data(format: u32, bytes: &[u8]) -> Result<()> {
    let memory = global_from_bytes(bytes)?;
    // SAFETY: the clipboard is open (the caller holds the guard) and `memory` is
    // a movable global block that is no longer locked.
    match unsafe { SetClipboardData(format, Some(HANDLE(memory.0))) } {
        // The system owns the memory now.
        Ok(_) => Ok(()),
        Err(err) => {
            free_global(memory);
            Err(os_error(err))
        }
    }
}

/// A new block of movable global memory holding a copy of `bytes`.
pub(super) fn global_from_bytes(bytes: &[u8]) -> Result<HGLOBAL> {
    // SAFETY: plain allocation of `bytes.len()` bytes of movable memory.
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }.map_err(os_error)?;
    if let Err(err) = fill(memory, bytes) {
        free_global(memory);
        return Err(err);
    }
    Ok(memory)
}

fn fill(memory: HGLOBAL, bytes: &[u8]) -> Result<()> {
    // SAFETY: `memory` is a live global block of at least `bytes.len()` bytes.
    let target = unsafe { GlobalLock(memory) };
    if target.is_null() {
        return Err(os_error(::windows::core::Error::from_thread()));
    }
    // SAFETY: `target` points to `bytes.len()` writable bytes that cannot overlap
    // the slice, and stays locked until the unlock below.
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast::<u8>(), bytes.len());
        // Unlock reports an error when the lock count reaches zero; that is success.
        let _ = GlobalUnlock(memory);
    }
    Ok(())
}

/// Free a block the receiver did not take.
pub(super) fn free_global(memory: HGLOBAL) {
    // SAFETY: the caller still owns `memory`, as nothing took it.
    if let Err(err) = unsafe { GlobalFree(Some(memory)) } {
        log::warn!("could not free global memory: {err}");
    }
}

/// A `CF_DIB` payload: a 40-byte `BITMAPINFOHEADER` (32 bits per pixel, no
/// compression, bottom-up rows) followed by BGRA pixels, last image row first.
fn dib_from_rgba(image: &RgbaImage) -> Vec<u8> {
    const HEADER_SIZE: u32 = 40;
    let (width, height) = (image.width(), image.height());
    let pixel_bytes = width * height * 4;

    let mut dib = Vec::with_capacity(HEADER_SIZE as usize + pixel_bytes as usize);
    dib.extend_from_slice(&HEADER_SIZE.to_le_bytes()); // biSize
    dib.extend_from_slice(&width.cast_signed().to_le_bytes()); // biWidth
    dib.extend_from_slice(&height.cast_signed().to_le_bytes()); // biHeight, positive = bottom-up
    dib.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    dib.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    dib.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    dib.extend_from_slice(&pixel_bytes.to_le_bytes()); // biSizeImage
    dib.extend_from_slice(&0i32.to_le_bytes()); // biXPelsPerMeter
    dib.extend_from_slice(&0i32.to_le_bytes()); // biYPelsPerMeter
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant

    for row in image.rows().rev() {
        for pixel in row {
            let [r, g, b, a] = pixel.0;
            dib.extend_from_slice(&[b, g, r, a]);
        }
    }
    dib
}

#[cfg(test)]
mod tests {
    use image::Rgba;

    use super::*;

    #[test]
    fn dib_is_a_bottom_up_bgra_bitmap() {
        let mut image = RgbaImage::new(2, 2);
        image.put_pixel(0, 0, Rgba([1, 2, 3, 4]));
        image.put_pixel(1, 0, Rgba([5, 6, 7, 8]));
        image.put_pixel(0, 1, Rgba([9, 10, 11, 12]));
        image.put_pixel(1, 1, Rgba([13, 14, 15, 16]));

        let dib = dib_from_rgba(&image);

        let u32_at = |at: usize| u32::from_le_bytes(dib[at..at + 4].try_into().unwrap());
        let u16_at = |at: usize| u16::from_le_bytes(dib[at..at + 2].try_into().unwrap());
        assert_eq!(u32_at(0), 40);
        assert_eq!(u32_at(4), 2);
        assert_eq!(u32_at(8), 2);
        assert_eq!(u16_at(14), 32);
        assert_eq!(u32_at(16), 0);
        assert_eq!(u32_at(20), 16);
        assert_eq!(dib.len(), 40 + 16);
        // The first stored row is the image's bottom row, channels B, G, R, A.
        assert_eq!(&dib[40..44], &[11, 10, 9, 12]);
        assert_eq!(&dib[44..48], &[15, 14, 13, 16]);
        assert_eq!(&dib[48..52], &[3, 2, 1, 4]);
        assert_eq!(&dib[52..56], &[7, 6, 5, 8]);
    }
}
