//! Windows: screen capture through `xcap` with Windows Graphics Capture.
//!
//! Minimal for now. Testing mixed DPI and negative coordinates will decide
//! whether monitor geometry should come straight from Win32 instead.

use xcap::{Monitor, Window, XCapError};

use super::{
    MonitorInfo, Permission, PermissionStatus, Platform, PlatformError, Result, RgbaImage,
    WindowInfo,
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
}
