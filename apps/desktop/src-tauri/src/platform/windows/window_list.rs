//! The top-level windows on screen, topmost first, for the capture overlay. The filter rules live in `window_pick`; this file only asks Windows.

// Windows APIs take plain references where clippy asks for raw pointers, and
// attribute sizes are a few bytes.
#![allow(clippy::borrow_as_ptr, clippy::cast_possible_truncation)]

use std::mem::size_of;

use ::windows::Win32::Foundation::{HWND, LPARAM, RECT};
use ::windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetClassNameW, GetLayeredWindowAttributes, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};
use ::windows::core::BOOL;

use super::super::geometry::DesktopRect;
use super::super::window_pick::{ListedWindow, WindowCandidate, listed_windows};
use super::super::{PlatformError, Result};

/// Collects every top-level window handle, in z-order. Keep going on `TRUE`.
unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` is the address of the `Vec` that `selectable_windows`
    // keeps alive for the whole `EnumWindows` call, used on this thread only.
    let handles = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
    handles.push(hwnd);
    BOOL::from(true)
}

fn class_is_desktop_shell(hwnd: HWND) -> bool {
    let mut name = [0u16; 32];
    // SAFETY: `name` is a valid buffer; the length written is returned.
    let length = unsafe { GetClassNameW(hwnd, &mut name) };
    let length = usize::try_from(length).unwrap_or(0);
    let class = String::from_utf16_lossy(&name[..length]);
    class == "Progman" || class == "WorkerW"
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: the out pointer is a `u32`, the size DWMWA_CLOAKED documents.
    let read = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            std::ptr::from_mut(&mut cloaked).cast(),
            size_of::<u32>() as u32,
        )
    };
    read.is_ok() && cloaked != 0
}

fn rect_to_desktop(rect: RECT) -> Option<DesktopRect> {
    Some(DesktopRect {
        x: rect.left,
        y: rect.top,
        width: u32::try_from(rect.right.checked_sub(rect.left)?).ok()?,
        height: u32::try_from(rect.bottom.checked_sub(rect.top)?).ok()?,
    })
}

/// The visible frame in physical pixels: the extended frame bounds leave out
/// the invisible resize border that `GetWindowRect` includes.
fn frame_bounds(hwnd: HWND) -> Option<DesktopRect> {
    let mut rect = RECT::default();
    // SAFETY: the out pointer is a `RECT`, the size DWMWA_EXTENDED_FRAME_BOUNDS documents.
    let read = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            std::ptr::from_mut(&mut rect).cast(),
            size_of::<RECT>() as u32,
        )
    };
    if read.is_err() {
        // SAFETY: `rect` is a valid out pointer.
        unsafe { GetWindowRect(hwnd, &mut rect) }.ok()?;
    }
    rect_to_desktop(rect)
}

/// True for a click-through window: one with the transparent style, or a
/// layered one that is fully transparent as a whole.
fn is_click_through(hwnd: HWND, style: isize) -> bool {
    let has = |flag: u32| style & isize::try_from(flag).unwrap_or(0) != 0;
    if has(WS_EX_TRANSPARENT.0) {
        return true;
    }
    if !has(WS_EX_LAYERED.0) {
        return false;
    }
    let mut alpha = 0u8;
    let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS::default();
    // SAFETY: both out pointers are valid for the call.
    let read =
        unsafe { GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha), Some(&mut flags)) };
    read.is_ok() && (flags & LWA_ALPHA).0 != 0 && alpha == 0
}

/// What Windows says about `hwnd`. The cheap checks run first and the rest
/// is skipped once the window is already dropped, so DWM is only asked about
/// windows that still matter.
fn candidate(hwnd: HWND) -> WindowCandidate {
    let mut candidate = WindowCandidate {
        bounds: None,
        // SAFETY: plain queries on a handle from `EnumWindows`; a stale handle just fails.
        visible: unsafe { IsWindowVisible(hwnd) }.as_bool(),
        minimised: false,
        cloaked: false,
        tool_window: false,
        desktop_shell: false,
        transparent: false,
        process_id: 0,
    };
    if !candidate.visible {
        return candidate;
    }
    // SAFETY: as above.
    candidate.minimised = unsafe { IsIconic(hwnd) }.as_bool();
    if candidate.minimised {
        return candidate;
    }
    // SAFETY: as above.
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    candidate.transparent = is_click_through(hwnd, style);
    if candidate.transparent {
        return candidate;
    }
    candidate.tool_window = style & isize::try_from(WS_EX_TOOLWINDOW.0).unwrap_or(0) != 0;
    let mut process_id = 0u32;
    // SAFETY: `process_id` is a valid out pointer.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    candidate.process_id = process_id;
    candidate.desktop_shell = class_is_desktop_shell(hwnd);
    if candidate.desktop_shell {
        return candidate;
    }
    candidate.cloaked = is_cloaked(hwnd);
    if candidate.cloaked {
        return candidate;
    }
    candidate.bounds = frame_bounds(hwnd);
    candidate
}

/// The windows on screen, topmost first, in physical desktop pixels, with
/// whether the user can pick each.
/// The calling thread must be per-monitor DPI aware, or the bounds are scaled.
pub fn listed_on_screen() -> Result<Vec<ListedWindow>> {
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: `handles` outlives the call and `collect` only pushes to it.
    unsafe {
        EnumWindows(
            Some(collect),
            LPARAM(std::ptr::from_mut(&mut handles) as isize),
        )
    }
    .map_err(|err| PlatformError::Os(err.to_string()))?;

    let own_process = std::process::id();
    Ok(listed_windows(
        handles.into_iter().map(candidate),
        own_process,
    ))
}
