//! Windows: screen capture through `xcap` with Windows Graphics Capture, the
//! region-selection overlay (`overlay`, Direct2D), the clipboard (`clipboard`),
//! and native dialogs and Settings pages through Win32.
//!
//! Minimal for now. Testing mixed DPI and negative coordinates will decide
//! whether monitor geometry should come straight from Win32 instead.
// The Win32 calls below are the only unsafe code in the app; each block says
// why it is sound.
#![allow(unsafe_code)]

use ::windows::Win32::UI::Shell::ShellExecuteW;
use ::windows::Win32::UI::WindowsAndMessaging::{
    IDYES, MB_DEFBUTTON1, MB_ICONQUESTION, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
    MB_YESNO, MESSAGEBOX_STYLE, MessageBoxW, SW_SHOWNORMAL,
};
use ::windows::core::{HSTRING, w};
use xcap::{Monitor, Window, XCapError};

mod clipboard;
mod overlay;

use super::{
    MonitorInfo, Permission, PermissionStatus, Platform, PlatformError, Result, RgbaImage,
    Selection, WindowInfo,
};

pub struct WindowsPlatform;

#[allow(clippy::needless_pass_by_value)]
fn os_error(err: XCapError) -> PlatformError {
    PlatformError::Os(err.to_string())
}

fn monitor_info(monitor: &Monitor) -> Result<MonitorInfo> {
    Ok(MonitorInfo {
        id: monitor.id().map_err(os_error)?,
        name: monitor.name().map_err(os_error)?,
        x: monitor.x().map_err(os_error)?,
        y: monitor.y().map_err(os_error)?,
        width: monitor.width().map_err(os_error)?,
        height: monitor.height().map_err(os_error)?,
        scale_factor: monitor.scale_factor().map_err(os_error)?,
        is_primary: monitor.is_primary().map_err(os_error)?,
    })
}

/// Ease of Access > Keyboard on Windows 10, Accessibility > Keyboard on
/// Windows 11; both hold the switch for the Print Screen key.
const KEYBOARD_SETTINGS_URI: &str = "ms-settings:easeofaccess-keyboard";

/// Show a modal message box and return the button the user pressed.
fn message_box(title: &str, text: &str, style: MESSAGEBOX_STYLE) -> Result<i32> {
    let title = HSTRING::from(title);
    let text = HSTRING::from(text);
    // SAFETY: both strings are null-terminated and outlive the call; no owner window.
    let answer = unsafe { MessageBoxW(None, &text, &title, style | MB_SETFOREGROUND | MB_TOPMOST) };
    if answer.0 == 0 {
        return Err(PlatformError::Os(
            ::windows::core::Error::from_thread().to_string(),
        ));
    }
    Ok(answer.0)
}

fn window_info(window: &Window) -> Result<WindowInfo> {
    Ok(WindowInfo {
        id: window.id().map_err(os_error)?,
        title: window.title().map_err(os_error)?,
        app_name: window.app_name().map_err(os_error)?,
        x: window.x().map_err(os_error)?,
        y: window.y().map_err(os_error)?,
        width: window.width().map_err(os_error)?,
        height: window.height().map_err(os_error)?,
    })
}

impl Platform for WindowsPlatform {
    fn monitors(&self) -> Result<Vec<MonitorInfo>> {
        Monitor::all()
            .map_err(os_error)?
            .iter()
            .map(monitor_info)
            .collect()
    }

    fn capture_all(&self) -> Result<Vec<(MonitorInfo, RgbaImage)>> {
        Monitor::all()
            .map_err(os_error)?
            .iter()
            .map(|monitor| {
                let image = monitor.capture_image().map_err(os_error)?;
                Ok((monitor_info(monitor)?, image))
            })
            .collect()
    }

    fn windows(&self) -> Result<Vec<WindowInfo>> {
        Window::all()
            .map_err(os_error)?
            .iter()
            .filter(|w| !w.is_minimized().unwrap_or(true))
            .map(window_info)
            .collect()
    }

    fn permissions(&self) -> PermissionStatus {
        PermissionStatus::Granted
    }

    fn request_permission(&self, _permission: Permission) -> Result<()> {
        Ok(())
    }

    fn open_print_screen_setting(&self) -> Result<()> {
        let uri = HSTRING::from(KEYBOARD_SETTINGS_URI);
        // SAFETY: the strings are null-terminated and outlive the call; the
        // target is a fixed Settings URI, nothing comes from the WebView.
        let result = unsafe { ShellExecuteW(None, w!("open"), &uri, None, None, SW_SHOWNORMAL) };
        // ShellExecuteW reports success with a value above 32.
        let code = result.0 as isize;
        if code <= 32 {
            return Err(PlatformError::Os(format!("ShellExecute error {code}")));
        }
        Ok(())
    }

    fn ask_yes_no(&self, title: &str, text: &str) -> Result<bool> {
        let answer = message_box(title, text, MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON1)?;
        Ok(answer == IDYES.0)
    }

    fn show_warning(&self, title: &str, text: &str) -> Result<()> {
        message_box(title, text, MB_OK | MB_ICONWARNING).map(|_| ())
    }

    fn select_region(&self, shots: &[(MonitorInfo, RgbaImage)]) -> Result<Option<Selection>> {
        overlay::select_region(shots)
    }

    fn copy_image(&self, image: &RgbaImage) -> Result<()> {
        clipboard::copy_image(image)
    }
}
