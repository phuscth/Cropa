//! The app's WebView windows (main, onboarding), created on demand.
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

use crate::platform::{self, OwnerWindow, Platform};

pub const MAIN: &str = "main";
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
    /// Whether the operating system draws the title bar and frame. The main
    /// window draws its own title bar in the page.
    decorations: bool,
    /// Whether the window is transparent and the page draws its edge: the
    /// main window rounds its corners in CSS, on Windows 10 too. The OS then
    /// paints no background, shadow or corner of its own.
    transparent: bool,
}

const SPECS: &[Spec] = &[
    Spec {
        label: MAIN,
        url: "src/windows/main/index.html",
        title: "Cropa",
        size: (1180.0, 760.0),
        min_size: Some((880.0, 520.0)),
        resizable: true,
        decorations: false,
        transparent: true,
    },
    Spec {
        label: ONBOARDING,
        url: "src/windows/onboarding/index.html",
        title: "Welcome to Cropa",
        size: (520.0, 560.0),
        min_size: None,
        resizable: false,
        decorations: true,
        transparent: false,
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

fn spec(label: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.label == label)
}

fn create<R: Runtime>(app: &AppHandle<R>, label: &str) -> tauri::Result<WebviewWindow<R>> {
    let spec = spec(label).ok_or_else(|| tauri::Error::WindowNotFound)?;
    let mut builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
        .title(spec.title)
        .inner_size(spec.size.0, spec.size.1)
        .resizable(spec.resizable)
        .maximizable(spec.resizable)
        .decorations(spec.decorations)
        .transparent(spec.transparent)
        // The native shadow of an undecorated window comes with a frame that
        // the OS draws square (Windows 10) or rounded at its own smaller
        // radius (Windows 11); around corners the page rounds, it would show.
        // It has no effect on a decorated window.
        .shadow(!spec.transparent)
        .center()
        .visible(false);
    if let Some((width, height)) = spec.min_size {
        builder = builder.min_inner_size(width, height);
    }
    let window = builder.build()?;
    if spec.transparent {
        if let Some(owner) = OwnerWindow::of(&window)
            && let Err(err) = platform::current().drop_native_corners(owner)
        {
            log::warn!("could not turn off the native corners of window `{label}`: {err}");
        }
    } else {
        match window.theme() {
            Ok(theme) => paint_background(&window, theme),
            Err(err) => log::warn!("could not read the theme of window `{label}`: {err}"),
        }
    }
    Ok(window)
}

/// Paint the native window and WebView background in `theme`, so a dark
/// window does not flash white before the page loads or while it is resized.
/// Called when a window is created and whenever its theme changes. The colours
/// match `--background` in packages/config/tailwind.css.
///
/// A transparent window is left alone: its page paints its own background,
/// and a native one would fill the corners the page leaves out.
pub fn paint_background<R: Runtime>(window: &WebviewWindow<R>, theme: tauri::Theme) {
    if spec(window.label()).is_some_and(|spec| spec.transparent) {
        return;
    }
    let background = match theme {
        tauri::Theme::Dark => Color(0x0d, 0x0d, 0x0d, 255),
        _ => Color(0xda, 0xda, 0xda, 255),
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
    use super::{CloseTimers, MAIN, ONBOARDING, SPECS};

    #[test]
    fn a_closed_window_is_destroyed_when_its_timer_fires() {
        let timers = CloseTimers::default();
        let token = timers.start(MAIN);
        assert!(timers.expire(MAIN, token));
        assert!(!timers.expire(MAIN, token), "a timer fires once");
    }

    #[test]
    fn showing_the_window_again_cancels_the_timer() {
        let timers = CloseTimers::default();
        let token = timers.start(MAIN);
        timers.cancel(MAIN);
        assert!(!timers.expire(MAIN, token));
    }

    #[test]
    fn only_the_latest_close_counts() {
        let timers = CloseTimers::default();
        let first = timers.start(MAIN);
        let second = timers.start(MAIN);
        assert!(!timers.expire(MAIN, first));
        assert!(timers.expire(MAIN, second));
    }

    #[test]
    fn windows_have_separate_timers() {
        let timers = CloseTimers::default();
        let main = timers.start(MAIN);
        let onboarding = timers.start(ONBOARDING);
        timers.cancel(MAIN);
        assert!(!timers.expire(MAIN, main));
        assert!(timers.expire(ONBOARDING, onboarding));
    }

    #[test]
    fn every_label_has_a_spec() {
        for label in [MAIN, ONBOARDING] {
            assert!(SPECS.iter().any(|spec| spec.label == label), "{label}");
        }
    }
}
