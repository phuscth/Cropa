//! Drag a file out of the app with the shell's own drag and drop: the shell
//! builds the data object for the file (`CF_HDROP`, the shell ID list, …), and
//! its default drop source draws the drag image.

use std::ffi::c_void;
use std::path::Path;

use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::System::Com::{
    DVASPECT_CONTENT, FORMATETC, IBindCtx, IDataObject, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
};
use ::windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use ::windows::Win32::System::Ole::{
    DROPEFFECT_COPY, DROPEFFECT_NONE, IDropSource, OleInitialize, OleUninitialize,
};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use ::windows::Win32::UI::Shell::{
    BHID_DataObject, IShellItem, SHCreateItemFromParsingName, SHDoDragDrop,
};
use ::windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
use ::windows::core::{HSTRING, w};

use super::super::{DragOutcome, OwnerWindow, PlatformError, Result};
use super::clipboard::{free_global, global_from_bytes};

#[allow(clippy::needless_pass_by_value)]
fn os_error(err: impl ToString) -> PlatformError {
    PlatformError::Os(err.to_string())
}

/// Balances a successful `OleInitialize` on this thread.
struct OleGuard;

impl OleGuard {
    fn init() -> Result<Self> {
        // SAFETY: no reserved argument. S_OK and S_FALSE (already initialised on
        // this thread, the normal case on the UI thread) both succeed and both
        // need one `OleUninitialize`.
        unsafe { OleInitialize(None) }.map_err(os_error)?;
        Ok(Self)
    }
}

impl Drop for OleGuard {
    fn drop(&mut self) {
        // SAFETY: balances the successful `OleInitialize` in `init`.
        unsafe { OleUninitialize() };
    }
}

/// Whether the button the user calls "left" is down. `GetAsyncKeyState` reads
/// the physical buttons, which swap when the user swaps them in Windows.
fn primary_button_down() -> bool {
    // SAFETY: a plain query with no pointers.
    let key = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } == 0 {
        VK_LBUTTON
    } else {
        VK_RBUTTON
    };
    // SAFETY: a plain query with no pointers. The high bit is set while the
    // button is down.
    unsafe { GetAsyncKeyState(i32::from(key.0)) }.cast_unsigned() & 0x8000 != 0
}

/// Offer the PNG bytes as a registered "PNG" format next to the file, for
/// targets that take image data.
fn offer_png(data: &IDataObject, png: &[u8]) -> Result<()> {
    // SAFETY: the format name is a null-terminated literal.
    let format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
    if format == 0 {
        return Err(os_error(::windows::core::Error::from_thread()));
    }
    let memory = global_from_bytes(png)?;
    let tymed = TYMED_HGLOBAL.0.cast_unsigned();
    let etc = FORMATETC {
        cfFormat: u16::try_from(format).map_err(|err| {
            free_global(memory);
            os_error(err)
        })?,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed,
    };
    let medium = STGMEDIUM {
        tymed,
        u: STGMEDIUM_0 { hGlobal: memory },
        pUnkForRelease: std::mem::ManuallyDrop::new(None),
    };
    // SAFETY: `etc` and `medium` live through the call and `memory` is an
    // unlocked movable global block. With `frelease` the data object owns the
    // memory once the call succeeds.
    match unsafe { data.SetData(&raw const etc, &raw const medium, true) } {
        Ok(()) => Ok(()),
        Err(err) => {
            free_global(memory);
            Err(os_error(err))
        }
    }
}

pub fn drag_file(owner: Option<OwnerWindow>, path: &Path, png: &[u8]) -> Result<DragOutcome> {
    // Without the button held, the default drop source would drop at once.
    if !primary_button_down() {
        return Ok(DragOutcome::NotStarted);
    }
    let _ole = OleGuard::init()?;

    let path = HSTRING::from(path.as_os_str());
    // SAFETY: the path string is null-terminated and outlives the call.
    let item: IShellItem =
        unsafe { SHCreateItemFromParsingName(&path, None::<&IBindCtx>) }.map_err(os_error)?;
    // SAFETY: `BHID_DataObject` is the shell's own handler id.
    let data: IDataObject =
        unsafe { item.BindToHandler(None::<&IBindCtx>, &BHID_DataObject) }.map_err(os_error)?;
    // The file alone is still worth dragging when the image data is refused.
    if let Err(err) = offer_png(&data, png) {
        log::warn!("dragging the file without image data: {err}");
    }

    let hwnd = owner.map(|window| HWND(window.0 as *mut c_void));
    // SAFETY: `data` is a live data object and this runs on the UI thread that
    // owns `hwnd`. `None` asks the shell for its default drop source.
    let effect = unsafe { SHDoDragDrop(hwnd, &data, None::<&IDropSource>, DROPEFFECT_COPY) }
        .map_err(os_error)?;
    // `DRAGDROP_S_CANCEL` and a drop nobody accepted both end with no effect.
    Ok(if effect == DROPEFFECT_NONE {
        DragOutcome::Cancelled
    } else {
        DragOutcome::Dropped
    })
}
