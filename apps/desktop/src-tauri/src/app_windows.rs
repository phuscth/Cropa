//! The app's WebView windows (editor, history, settings, onboarding), created on demand.
//!
//! Nothing is created at startup, so a Cropa that only sits in the tray holds
//! no WebView. Closing a window hides it; if it is not shown again within
//! [`DESTROY_AFTER`], it is destroyed to give the memory back. Capabilities
//! still apply because they match windows by label.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::window::Color;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const EDITOR: &str = "editor";
pub const HISTORY: &str = "history";
pub const SETTINGS: &str = "settings";
pub const ONBOARDING: &str = "onboarding";

/// How long a closed window stays hidden before it is destroyed.
pub const DESTROY_AFTER: Duration = Duration::from_secs(5 * 60);

struct Spec {
    label: &'static str,
    url: &'static str,
    title: &'static str,
    size: (f64, f64),
    min_size: Option<(f64, f64)>,
    resizable: bool,
}

const SPECS: &[Spec] = &[
    Spec {
        label: EDITOR,
        url: "src/windows/editor/index.html",
        title: "Cropa",
        size: (1100.0, 720.0),
        min_size: Some((720.0, 480.0)),
        resizable: true,
    },
    Spec {
        label: HISTORY,
        url: "src/windows/history/index.html",
        title: "Cropa History",
        size: (900.0, 640.0),
        min_size: Some((560.0, 400.0)),
        resizable: true,
    },
    Spec {
        label: SETTINGS,
        url: "src/windows/settings/index.html",
        title: "Cropa Settings",
        size: (560.0, 520.0),
        min_size: None,
        resizable: false,
    },
    Spec {
        label: ONBOARDING,
        url: "src/windows/onboarding/index.html",
        title: "Welcome to Cropa",
        size: (520.0, 560.0),
        min_size: None,
        resizable: false,
    },
];

/// Show a window, creating it first if needed, and bring it to the front.
/// Returns whether the window exists: `false` only when it could not be
/// created. A failure to show or focus an existing window is logged, not
/// reported.
pub fn show<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    app.state::<CloseTimers>().cancel(label);
    let window = match app.get_webview_window(label) {
        Some(window) => window,
        None => match create(app, label) {
            Ok(window) => window,
            Err(err) => {
                log::error!("could not create window `{label}`: {err}");
                return false;
            }
        },
    };
    let result = window
        .show()
        .and_then(|()| window.unminimize())
        .and_then(|()| window.set_focus());
    if let Err(err) = result {
        log::warn!("could not show window `{label}`: {err}");
    }
    true
}

fn create<R: Runtime>(app: &AppHandle<R>, label: &str) -> tauri::Result<WebviewWindow<R>> {
    let spec = SPECS
        .iter()
        .find(|spec| spec.label == label)
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let mut builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
        .title(spec.title)
        .inner_size(spec.size.0, spec.size.1)
        .resizable(spec.resizable)
        .maximizable(spec.resizable)
        .center()
        .visible(false);
    if let Some((width, height)) = spec.min_size {
        builder = builder.min_inner_size(width, height);
    }
    let window = builder.build()?;
    match window.theme() {
        Ok(theme) => paint_background(&window, theme),
        Err(err) => log::warn!("could not read the theme of window `{label}`: {err}"),
    }
    Ok(window)
}

/// Paint the native window and WebView background in `theme`, so a dark
/// window does not flash white before the page loads or while it is resized.
/// Called when a window is created and whenever its theme changes. The colours
/// match `--background` in packages/config/tailwind.css.
pub fn paint_background<R: Runtime>(window: &WebviewWindow<R>, theme: tauri::Theme) {
    let background = match theme {
        tauri::Theme::Dark => Color(0x19, 0x19, 0x19, 255),
        _ => Color(0xfa, 0xfa, 0xfa, 255),
    };
    if let Err(err) = window.set_background_color(Some(background)) {
        log::warn!(
            "could not set the background of window `{}`: {err}",
            window.label()
        );
    }
}

/// Called on `CloseRequested`: hide now, destroy later unless shown again.
pub fn hide_then_destroy<R: Runtime>(window: &tauri::Window<R>) {
    if let Err(err) = window.hide() {
        log::warn!("could not hide window: {err}");
    }
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let token = app.state::<CloseTimers>().start(&label);
    std::thread::spawn(move || {
        std::thread::sleep(DESTROY_AFTER);
        if !app.state::<CloseTimers>().expire(&label, token) {
            return;
        }
        if let Some(window) = app.get_webview_window(&label)
            && let Err(err) = window.destroy()
        {
            log::warn!("could not destroy window `{label}`: {err}");
        }
    });
}

/// Pending "destroy after close" timers, one per window label. Showing a
/// window or closing it again invalidates the earlier timer.
#[derive(Default)]
pub struct CloseTimers {
    pending: Mutex<HashMap<String, u64>>,
    next: Mutex<u64>,
}

impl CloseTimers {
    /// A window was closed: start a timer and return its token.
    pub fn start(&self, label: &str) -> u64 {
        let token = {
            let mut next = self
                .next
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *next += 1;
            *next
        };
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(label.to_owned(), token);
        token
    }

    /// A window was shown: forget its timer.
    pub fn cancel(&self, label: &str) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(label);
    }

    /// The timer fired: true if it is still the current one for this window,
    /// in which case the window should be destroyed.
    pub fn expire(&self, label: &str, token: u64) -> bool {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending.get(label) == Some(&token) {
            pending.remove(label);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CloseTimers, EDITOR, HISTORY, ONBOARDING, SETTINGS, SPECS};

    #[test]
    fn a_closed_window_is_destroyed_when_its_timer_fires() {
        let timers = CloseTimers::default();
        let token = timers.start(EDITOR);
        assert!(timers.expire(EDITOR, token));
        assert!(!timers.expire(EDITOR, token), "a timer fires once");
    }

    #[test]
    fn showing_the_window_again_cancels_the_timer() {
        let timers = CloseTimers::default();
        let token = timers.start(EDITOR);
        timers.cancel(EDITOR);
        assert!(!timers.expire(EDITOR, token));
    }

    #[test]
    fn only_the_latest_close_counts() {
        let timers = CloseTimers::default();
        let first = timers.start(EDITOR);
        let second = timers.start(EDITOR);
        assert!(!timers.expire(EDITOR, first));
        assert!(timers.expire(EDITOR, second));
    }

    #[test]
    fn windows_have_separate_timers() {
        let timers = CloseTimers::default();
        let editor = timers.start(EDITOR);
        let settings = timers.start(SETTINGS);
        timers.cancel(EDITOR);
        assert!(!timers.expire(EDITOR, editor));
        assert!(timers.expire(SETTINGS, settings));
    }

    #[test]
    fn every_label_has_a_spec() {
        for label in [EDITOR, HISTORY, SETTINGS, ONBOARDING] {
            assert!(SPECS.iter().any(|spec| spec.label == label), "{label}");
        }
    }
}
