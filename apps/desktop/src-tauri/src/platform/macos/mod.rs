//! macOS: stub until sponsored (planned: ScreenCaptureKit, Screen Recording permission).

use std::path::{Path, PathBuf};

use super::{
    MonitorInfo, OwnerWindow, Permission, PermissionStatus, Platform, PlatformError, PreviewHandle,
    Result, RgbaImage, SaveFileType, Selection, WindowInfo,
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

    fn select_region(&self, _shots: &[(MonitorInfo, RgbaImage)]) -> Result<Option<Selection>> {
        Err(PlatformError::Unsupported)
    }

    fn copy_image(&self, _image: &RgbaImage, _exclude_from_history: bool) -> Result<()> {
        Err(PlatformError::Unsupported)
    }

    fn show_preview(&self, _image: &RgbaImage, _on: &MonitorInfo) -> Result<PreviewHandle> {
        Err(PlatformError::Unsupported)
    }

    fn pick_folder(
        &self,
        _owner: Option<OwnerWindow>,
        _title: &str,
        _start_in: Option<&Path>,
    ) -> Result<Option<PathBuf>> {
        Err(PlatformError::Unsupported)
    }

    fn pick_save_path(
        &self,
        _owner: Option<OwnerWindow>,
        _title: &str,
        _types: &[SaveFileType<'_>],
        _initial_type: usize,
        _file_name: &str,
        _start_in: Option<&Path>,
    ) -> Result<Option<(PathBuf, usize)>> {
        Err(PlatformError::Unsupported)
    }

    fn reveal_file(&self, _path: &Path) -> Result<()> {
        Err(PlatformError::Unsupported)
    }

    fn open_web_page(&self, _url: &'static str) -> Result<()> {
        Err(PlatformError::Unsupported)
    }
}
