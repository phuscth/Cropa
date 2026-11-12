//! Everything that differs between operating systems sits behind [`Platform`].
//!
//! Coordinates are always **physical pixels**; conversion to logical units only
//! happens at the UI edge.
//!
//! This defines the contract only; region capture will be the first caller.
#![allow(dead_code)]

#[cfg(not(any(windows, target_os = "macos")))]
compile_error!("Cropa supports Windows and macOS only");

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
