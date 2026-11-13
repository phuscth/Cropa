//! System tray: Capture region, History, Open editor, Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Runtime};

use crate::capture::{self, CaptureSource};
use crate::i18n::{Lang, tray_text};
use crate::main_window::{MainView, show_main};

const CAPTURE: &str = "capture";
const HISTORY: &str = "history";
const EDITOR: &str = "editor";
const QUIT: &str = "quit";

pub fn create<R: Runtime>(app: &AppHandle<R>, lang: Lang) -> tauri::Result<()> {
    let text = tray_text(lang);
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, CAPTURE, text.capture, true, None::<&str>)?,
            &MenuItem::with_id(app, HISTORY, text.history, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, EDITOR, text.editor, true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, text.quit, true, None::<&str>)?,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(text.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            CAPTURE => capture::request(app, CaptureSource::Tray),
            HISTORY => drop(show_main(app, MainView::History)),
            EDITOR => drop(show_main(app, MainView::Editor)),
            QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click opens the editor; right click shows the menu.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle(), MainView::Editor);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
