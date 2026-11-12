//! Per-thread DPI awareness shared by the windows Cropa draws itself.

use ::windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};

/// Makes the calling thread per-monitor DPI aware, so window sizes and
/// coordinates are physical pixels. Restores the previous awareness when dropped.
pub struct DpiGuard(DPI_AWARENESS_CONTEXT);

impl DpiGuard {
    pub fn per_monitor() -> Self {
        // SAFETY: changes only this thread's awareness; the previous value is restored on drop.
        Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
    }
}

impl Drop for DpiGuard {
    fn drop(&mut self) {
        if !self.0.0.is_null() {
            // SAFETY: `self.0` came from the earlier call on this thread.
            unsafe { SetThreadDpiAwarenessContext(self.0) };
        }
    }
}
