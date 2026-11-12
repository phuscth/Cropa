//! macOS: stub until sponsored (planned: ScreenCaptureKit, Screen Recording permission).

use super::{
    MonitorInfo, Permission, PermissionStatus, Platform, PlatformError, Result, RgbaImage,
    WindowInfo,
};

pub struct MacosPlatform;

impl Platform for MacosPlatform {
    fn monitors(&self) -> Result<Vec<MonitorInfo>> {
        Err(PlatformError::Unsupported)
    }

    fn capture_all(&self) -> Result<Vec<(MonitorInfo, RgbaImage)>> {
        Err(PlatformError::Unsupported)
    }

    fn windows(&self) -> Result<Vec<WindowInfo>> {
        Err(PlatformError::Unsupported)
    }

    fn permissions(&self) -> PermissionStatus {
        PermissionStatus::NotDetermined
    }

    fn request_permission(&self, _permission: Permission) -> Result<()> {
        Err(PlatformError::Unsupported)
    }

    fn open_print_screen_setting(&self) -> Result<()> {
        Err(PlatformError::Unsupported)
    }

    fn ask_yes_no(&self, _title: &str, _text: &str) -> Result<bool> {
        Err(PlatformError::Unsupported)
    }

    fn show_warning(&self, _title: &str, _text: &str) -> Result<()> {
        Err(PlatformError::Unsupported)
    }
}
