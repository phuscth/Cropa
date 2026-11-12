use std::path::PathBuf;
use std::sync::Mutex;

use crate::settings::Settings;
use crate::shortcut::ShortcutStatus;

/// Shared app state, managed by Tauri. One mutex: contention is negligible
/// (settings change only on user action).
pub struct AppState {
    pub inner: Mutex<Inner>,
}

pub struct Inner {
    pub settings_path: PathBuf,
    pub settings: Settings,
    pub shortcut: ShortcutStatus,
}

impl AppState {
    pub fn new(settings_path: PathBuf, settings: Settings) -> Self {
        let shortcut = ShortcutStatus::unregistered(&settings.capture_shortcut);
        Self {
            inner: Mutex::new(Inner {
                settings_path,
                settings,
                shortcut,
            }),
        }
    }

    /// Lock the state. A poisoned lock only means another thread panicked while
    /// holding it; the data is still usable, so recover instead of crashing.
    pub fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
