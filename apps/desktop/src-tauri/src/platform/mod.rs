//! Everything that differs between operating systems sits behind [`Platform`].
//!
//! Coordinates are always **physical pixels**; conversion to logical units only
//! happens at the UI edge.
// Part of the contract has no caller yet (window mode, permissions).
#![allow(dead_code)]

#[cfg(not(any(windows, target_os = "macos")))]
compile_error!("Cropa supports Windows and macOS only");

pub(crate) mod geometry;
#[cfg(target_os = "macos")]
mod macos;
pub(crate) mod window_pick;
#[cfg(windows)]
mod windows;

pub use image::RgbaImage;

use std::path::{Path, PathBuf};

/// An opaque native handle to the window a dialog belongs to (the HWND, as an
/// integer, on Windows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnerWindow(isize);

impl OwnerWindow {
    /// The native handle of a Tauri window, for the dialogs it owns. `None`
    /// when the OS has no handle for it or the platform does not use one.
    pub fn of<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Option<Self> {
        #[cfg(windows)]
        {
            window.hwnd().ok().map(|hwnd| Self(hwnd.0 as isize))
        }
        #[cfg(not(windows))]
        {
            let _ = window;
            None
        }
    }
}

/// One entry of the file-type list in a save dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaveFileType<'a> {
    pub label: &'a str,
    /// Without the dot: `png`.
    pub extension: &'a str,
}

/// One display, in physical pixels on the virtual desktop.
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    /// Top-left corner. Can be negative for displays left of or above the primary one.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

/// A rectangle in physical pixels, half-open: covers x..x+width, y..y+height.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// How the user picks what to capture on the overlay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CaptureMode {
    #[default]
    Region,
    Window,
    FullScreen,
}

impl CaptureMode {
    pub fn log_name(self) -> &'static str {
        match self {
            Self::Region => "region",
            Self::Window => "window",
            Self::FullScreen => "full screen",
        }
    }
}

/// What the user selected: an index into the `shots` given to `select_region`,
/// and the rectangle in that monitor's capture, in the capture's own pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Selection {
    pub monitor: usize,
    pub rect: PixelRect,
    /// The mode the selection was made in.
    pub mode: CaptureMode,
    /// When the mouse button was released, to measure how long the copy takes.
    pub released_at: std::time::Instant,
}

/// A top-level window, used later for window-mode capture (bbox crop).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    /// macOS Screen Recording. Always granted on Windows.
    ScreenRecording,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionStatus {
    Granted,
    Denied,
    NotDetermined,
}

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("the operating system refused the request: {0}")]
    Os(String),
    #[error("not supported on this platform yet")]
    Unsupported,
}

pub type Result<T> = std::result::Result<T, PlatformError>;

pub trait Platform {
    fn monitors(&self) -> Result<Vec<MonitorInfo>>;
    fn capture_all(&self) -> Result<Vec<(MonitorInfo, RgbaImage)>>;
    fn windows(&self) -> Result<Vec<WindowInfo>>;
    fn permissions(&self) -> PermissionStatus;
    fn request_permission(&self, permission: Permission) -> Result<()>;
    /// Open the OS page where the user can stop the OS from using the Print
    /// Screen key.
    fn open_print_screen_setting(&self) -> Result<()>;
    /// Modal native question with Yes as the default button. Blocks the
    /// calling thread until the user answers.
    fn ask_yes_no(&self, title: &str, text: &str) -> Result<bool>;
    /// Modal native notice with an OK button. Blocks the calling thread.
    fn show_warning(&self, title: &str, text: &str) -> Result<()>;
    /// Cover every monitor with its frozen capture and let the user drag a
    /// region, or switch to picking a window or a whole monitor. Blocks the
    /// calling thread (which must not be the UI event loop) until the user
    /// releases the mouse on a target (`Some`) or cancels (`None`).
    fn select_region(&self, shots: &[(MonitorInfo, RgbaImage)]) -> Result<Option<Selection>>;
    /// Put an image on the clipboard, replacing its contents. With
    /// `exclude_from_history`, the OS is asked to keep it out of its clipboard
    /// history and cloud sync.
    fn copy_image(&self, image: &RgbaImage, exclude_from_history: bool) -> Result<()>;
    /// Show a small floating preview of `image` in the corner of monitor `on`,
    /// without taking the keyboard focus. Returns once the preview is on screen.
    fn show_preview(&self, image: &RgbaImage, on: &MonitorInfo) -> Result<PreviewHandle>;
    /// Native folder picker. `Ok(None)` when the user cancels. Blocks the
    /// calling thread (not the UI event loop) until the dialog closes.
    fn pick_folder(
        &self,
        owner: Option<OwnerWindow>,
        title: &str,
        start_in: Option<&Path>,
    ) -> Result<Option<PathBuf>>;
    /// Native Save as dialog. Returns the chosen path and the index into
    /// `types` of the file type selected when the user confirmed; `Ok(None)`
    /// when the user cancels. Asks before replacing an existing file. Blocks
    /// the calling thread (not the UI event loop).
    fn pick_save_path(
        &self,
        owner: Option<OwnerWindow>,
        title: &str,
        types: &[SaveFileType<'_>],
        initial_type: usize,
        file_name: &str,
        start_in: Option<&Path>,
    ) -> Result<Option<(PathBuf, usize)>>;
    /// Open the folder that holds `path` with the file selected.
    fn reveal_file(&self, path: &Path) -> Result<()>;
    /// Open a web page in the default browser. Only fixed addresses.
    fn open_web_page(&self, url: &'static str) -> Result<()>;
    /// Run `program` with `args` in a new console window that stays open after
    /// the program ends, so the user can type into it and read its result.
    /// Returns once the window is open; does not wait for it.
    fn open_console(&self, program: &Path, args: &[&str]) -> Result<()>;
    /// Start an OS drag (copy only) of the file at `path`, also offering `png`
    /// as image data. Must be called on the UI thread while the left mouse
    /// button is held. Blocks, pumping messages, until the user drops or
    /// cancels; `NotStarted` when the button is already up.
    fn drag_file(&self, owner: Option<OwnerWindow>, path: &Path, png: &[u8])
    -> Result<DragOutcome>;
}

/// How a drag started by [`Platform::drag_file`] ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragOutcome {
    Dropped,
    Cancelled,
    NotStarted,
}

/// What the user chose on a floating preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewAction {
    Edit,
    Dismiss,
}

/// Closes a preview and returns once it is gone. Safe to call after the
/// preview already closed itself.
pub struct PreviewCloser(Box<dyn FnOnce() + Send>);

impl PreviewCloser {
    pub fn new(close: impl FnOnce() + Send + 'static) -> Self {
        Self(Box::new(close))
    }

    pub fn close(self) {
        (self.0)();
    }
}

/// A floating preview on screen. The receiver yields the user's choice once;
/// it disconnects without a value when the preview is closed another way.
pub struct PreviewHandle {
    pub actions: std::sync::mpsc::Receiver<PreviewAction>,
    pub closer: PreviewCloser,
}

/// The implementation for the OS this binary was built for.
pub fn current() -> impl Platform {
    #[cfg(windows)]
    {
        windows::WindowsPlatform
    }
    #[cfg(target_os = "macos")]
    {
        macos::MacosPlatform
    }
}
