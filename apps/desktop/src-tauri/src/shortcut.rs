//! The global capture shortcut: register, report conflicts, change.

use std::str::FromStr;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_specta::Event;

use crate::capture::{self, CaptureSource};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum ShortcutErrorKind {
    /// The text is not a valid accelerator (e.g. no main key).
    Invalid,
    /// The OS refused it, almost always because another app holds it.
    InUse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub accelerator: String,
    pub registered: bool,
    pub error: Option<ShortcutErrorKind>,
}

impl ShortcutStatus {
    pub fn unregistered(accelerator: &str) -> Self {
        Self {
            accelerator: accelerator.to_owned(),
            registered: false,
            error: None,
        }
    }

    fn ok(accelerator: &str) -> Self {
        Self {
            registered: true,
            ..Self::unregistered(accelerator)
        }
    }

    fn failed(accelerator: &str, kind: ShortcutErrorKind) -> Self {
        Self {
            error: Some(kind),
            ..Self::unregistered(accelerator)
        }
    }
}

/// Parse an accelerator. Only combinations with at least one modifier are
/// accepted: a bare key as a global shortcut would swallow normal typing.
pub fn parse(accelerator: &str) -> Result<Shortcut, ShortcutErrorKind> {
    let shortcut = Shortcut::from_str(accelerator).map_err(|_| ShortcutErrorKind::Invalid)?;
    if shortcut.mods.is_empty() {
        return Err(ShortcutErrorKind::Invalid);
    }
    Ok(shortcut)
}

fn register<R: Runtime>(app: &AppHandle<R>, shortcut: Shortcut) -> Result<(), ShortcutErrorKind> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                capture::request(app, CaptureSource::Hotkey);
            }
        })
        .map_err(|err| {
            log::warn!("global shortcut registration failed: {err}");
            ShortcutErrorKind::InUse
        })
}

/// Register the shortcut stored in settings. Called once at startup.
pub fn register_from_settings<R: Runtime>(app: &AppHandle<R>) -> ShortcutStatus {
    let state = app.state::<AppState>();
    let accelerator = state.lock().settings.capture_shortcut.clone();
    let status = match parse(&accelerator).and_then(|s| register(app, s)) {
        Ok(()) => ShortcutStatus::ok(&accelerator),
        Err(kind) => ShortcutStatus::failed(&accelerator, kind),
    };
    state.lock().shortcut = status.clone();
    status
}

/// A new shortcut registered next to the old one but not yet in effect for the
/// app state. The caller saves settings, then either [`commit`](Self::commit)s
/// (release the old shortcut) or [`rollback`](Self::rollback)s (release the new
/// one), so the OS, the app state and `settings.json` never disagree.
#[must_use = "a pending change must be committed or rolled back"]
pub struct PendingChange {
    accelerator: String,
    new: Shortcut,
    old: Option<Shortcut>,
}

/// Start switching to `accelerator`. The new shortcut is registered **before**
/// the old one is released, so a conflict leaves the working shortcut untouched.
pub fn begin_change<R: Runtime>(
    app: &AppHandle<R>,
    accelerator: &str,
) -> Result<PendingChange, ShortcutErrorKind> {
    let new = parse(accelerator)?;
    let current = app.state::<AppState>().lock().shortcut.clone();
    let old = current
        .registered
        .then(|| parse(&current.accelerator).ok())
        .flatten();
    if old != Some(new) {
        register(app, new)?;
    }
    Ok(PendingChange {
        accelerator: accelerator.to_owned(),
        new,
        old,
    })
}

impl PendingChange {
    fn changed(&self) -> bool {
        self.old != Some(self.new)
    }

    /// Settings are saved: release the old shortcut and publish the new status.
    pub fn commit<R: Runtime>(self, app: &AppHandle<R>) -> ShortcutStatus {
        if self.changed()
            && let Some(old) = self.old
            && let Err(err) = app.global_shortcut().unregister(old)
        {
            log::warn!("could not release the previous shortcut: {err}");
        }
        let status = ShortcutStatus::ok(&self.accelerator);
        app.state::<AppState>().lock().shortcut = status.clone();
        if let Err(err) = status.emit(app) {
            log::warn!("could not emit shortcut status: {err}");
        }
        status
    }

    /// Saving failed: release the new shortcut; the old one never stopped working.
    pub fn rollback<R: Runtime>(self, app: &AppHandle<R>) {
        if self.changed()
            && let Err(err) = app.global_shortcut().unregister(self.new)
        {
            log::warn!("could not release the shortcut after a failed save: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ShortcutErrorKind, parse};

    #[test]
    fn accepts_the_default_and_common_forms() {
        assert!(parse("Alt+Shift+S").is_ok());
        assert!(parse("CommandOrControl+Shift+2").is_ok());
        assert!(parse("Ctrl+Alt+F12").is_ok());
    }

    #[test]
    fn rejects_garbage_and_bare_keys() {
        assert_eq!(parse(""), Err(ShortcutErrorKind::Invalid));
        assert_eq!(parse("Alt+Shift"), Err(ShortcutErrorKind::Invalid));
        assert_eq!(parse("NotAKey+S"), Err(ShortcutErrorKind::Invalid));
        assert_eq!(parse("S"), Err(ShortcutErrorKind::Invalid));
    }

    #[test]
    fn modifier_order_does_not_matter() {
        assert_eq!(parse("Alt+Shift+S"), parse("Shift+Alt+S"));
    }
}
