//! Windows: screen capture through `xcap` with Windows Graphics Capture, the
//! region-selection overlay (`overlay`, Direct2D), the floating preview
//! (`preview`), the clipboard (`clipboard`), and native dialogs and Settings pages through Win32.
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
mod dialog;
mod dpi;
mod drag;
mod overlay;
mod preview;
mod window_list;

use std::path::{Path, PathBuf};

use super::{
    DragOutcome, MonitorInfo, OwnerWindow, Permission, PermissionStatus, Platform, PlatformError,
    PreviewHandle, Result, RgbaImage, SaveFileType, Selection, WindowInfo,
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

/// Open a fixed URI or web address with the program Windows has for it.
fn shell_open(target: &'static str) -> Result<()> {
    let target = HSTRING::from(target);
    // SAFETY: the strings are null-terminated and outlive the call; the target
    // is a compile-time constant, nothing comes from the WebView.
    let result = unsafe { ShellExecuteW(None, w!("open"), &target, None, None, SW_SHOWNORMAL) };
    // ShellExecuteW reports success with a value above 32.
    let code = result.0 as isize;
    if code <= 32 {
        return Err(PlatformError::Os(format!("ShellExecute error {code}")));
    }
    Ok(())
}

/// `cmd.exe` in the Windows folder.
fn cmd_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    root.join("System32").join("cmd.exe")
}

/// The parameters that make `cmd.exe` run `program args` and stay open (`/k`).
/// `cmd` parses this line, so a program path with a quote, `%`, `!` or a
/// control character is refused, and so is an argument that is not a plain
/// lowercase word.
fn console_parameters(program: &Path, args: &[&str]) -> Result<String> {
    let program = program
        .to_str()
        .ok_or_else(|| PlatformError::Os("the program path is not valid text".into()))?;
    if program.is_empty()
        || program
            .chars()
            .any(|c| matches!(c, '"' | '%' | '!') || c.is_control())
    {
        return Err(PlatformError::Os(
            "the program path has a character that cannot be passed to the console".into(),
        ));
    }
    if let Some(bad) = args
        .iter()
        .find(|arg| arg.is_empty() || !arg.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'))
    {
        return Err(PlatformError::Os(format!(
            "the console argument {bad:?} is not a plain word"
        )));
    }
    let mut line = format!("\"{program}\"");
    for arg in args {
        line.push(' ');
        line.push_str(arg);
    }
    Ok(format!("/k \"{line}\""))
}

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
        shell_open(KEYBOARD_SETTINGS_URI)
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

    fn copy_image(&self, image: &RgbaImage, exclude_from_history: bool) -> Result<()> {
        clipboard::copy_image(image, exclude_from_history)
    }

    fn show_preview(&self, image: &RgbaImage, on: &MonitorInfo) -> Result<PreviewHandle> {
        preview::show_preview(image, on)
    }

    fn pick_folder(
        &self,
        owner: Option<OwnerWindow>,
        title: &str,
        start_in: Option<&Path>,
    ) -> Result<Option<PathBuf>> {
        dialog::pick_folder(owner, title, start_in)
    }

    fn pick_save_path(
        &self,
        owner: Option<OwnerWindow>,
        title: &str,
        types: &[SaveFileType<'_>],
        initial_type: usize,
        file_name: &str,
        start_in: Option<&Path>,
    ) -> Result<Option<(PathBuf, usize)>> {
        dialog::pick_save_path(owner, title, types, initial_type, file_name, start_in)
    }

    fn reveal_file(&self, path: &Path) -> Result<()> {
        dialog::reveal_file(path)
    }

    fn open_web_page(&self, url: &'static str) -> Result<()> {
        shell_open(url)
    }

    fn open_console(&self, program: &Path, args: &[&str]) -> Result<()> {
        let parameters = HSTRING::from(console_parameters(program, args)?);
        let cmd = HSTRING::from(cmd_exe().as_os_str());
        // SAFETY: the strings are null-terminated and outlive the call; the
        // program is the path Cropa found and the arguments are fixed words,
        // both checked by `console_parameters`.
        let result =
            unsafe { ShellExecuteW(None, w!("open"), &cmd, &parameters, None, SW_SHOWNORMAL) };
        // ShellExecuteW reports success with a value above 32.
        let code = result.0 as isize;
        if code <= 32 {
            return Err(PlatformError::Os(format!("ShellExecute error {code}")));
        }
        Ok(())
    }

    fn drag_file(
        &self,
        owner: Option<OwnerWindow>,
        path: &Path,
        png: &[u8],
    ) -> Result<DragOutcome> {
        drag::drag_file(owner, path, png)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_console_line_quotes_the_program_and_keeps_the_window_open() {
        let line = console_parameters(
            Path::new(r"C:\Program Files\nodejs\codex.cmd"),
            &["auth", "login"],
        );
        assert_eq!(
            line.unwrap(),
            r#"/k ""C:\Program Files\nodejs\codex.cmd" auth login""#
        );
    }

    #[test]
    fn a_program_path_cmd_could_misread_is_refused() {
        for path in ["C:/a\"b/x", "C:/%PATH%/x", "C:/hi!/x", "C:/a\nb/x", ""] {
            assert!(
                console_parameters(Path::new(path), &["login"]).is_err(),
                "{path:?}"
            );
        }
        // `&` is safe inside the quotes.
        assert!(console_parameters(Path::new(r"C:\a&b\x"), &["login"]).is_ok());
    }

    #[test]
    fn only_plain_words_are_accepted_as_arguments() {
        let program = Path::new(r"C:\x\claude.exe");
        assert!(console_parameters(program, &["auth", "login"]).is_ok());
        for arg in ["Login", "a b", "a&b", "--x=1", "", "a\"b"] {
            assert!(console_parameters(program, &[arg]).is_err(), "{arg:?}");
        }
    }
}
