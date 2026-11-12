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
#[cfg(windows)]
mod windows;

pub use image::RgbaImage;

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

/// What the user selected: an index into the `shots` given to `select_region`,
/// and the rectangle in that monitor's capture, in the capture's own pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Selection {
    pub monitor: usize,
    pub rect: PixelRect,
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
    /// Cover every monitor with its frozen capture and let the user drag a region.
    /// Blocks the calling thread (which must not be the UI event loop) until the
    /// user releases the mouse (`Some`) or presses Esc (`None`).
    fn select_region(&self, shots: &[(MonitorInfo, RgbaImage)]) -> Result<Option<Selection>>;
    /// Put an image on the clipboard, replacing its contents. With
    /// `exclude_from_history`, the OS is asked to keep it out of its clipboard
    /// history and cloud sync.
    fn copy_image(&self, image: &RgbaImage, exclude_from_history: bool) -> Result<()>;
    /// Show a small floating preview of `image` in the corner of monitor `on`,
    /// without taking the keyboard focus. Returns once the preview is on screen.
    fn show_preview(&self, image: &RgbaImage, on: &MonitorInfo) -> Result<PreviewHandle>;
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
