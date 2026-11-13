//! Cropa desktop: the thin layer that wires Tauri to the platform code and
//! the pure crates.

mod app_windows;
mod capture;
mod commands;
mod editor;
mod export;
mod first_run;
mod history;
mod i18n;
mod platform;
mod presets;
mod settings;
mod shortcut;
mod state;
mod tray;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_specta::{ErrorHandlingMode, collect_commands, collect_events};

use crate::state::AppState;

/// The typed command and event surface shared with the WebView.
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::settings::get_settings,
            commands::settings::get_shortcut_status,
            commands::settings::set_capture_shortcut,
            commands::settings::open_print_screen_setting,
            commands::settings::set_theme,
            commands::settings::get_autostart,
            commands::settings::set_autostart,
            commands::settings::set_save_history,
            commands::settings::set_exclude_from_clipboard_history,
            commands::history::list_history,
            commands::history::get_history_thumbnail,
            commands::history::copy_history_image,
            commands::history::delete_history_image,
            commands::history::delete_all_history,
            commands::history::open_history_in_editor,
            commands::editor::get_editor_image,
            commands::export::quick_save,
            commands::export::choose_save_as_path,
            commands::export::write_save_as,
            commands::export::copy_rendered_image,
            commands::export::reveal_saved_file,
            commands::settings::choose_save_folder,
            commands::settings::reset_save_folder,
            commands::settings::open_sponsors_page,
            commands::presets::list_user_presets,
            commands::presets::save_user_preset,
            commands::presets::delete_user_preset,
            commands::presets::save_preset_file,
        ])
        .events(collect_events![
            capture::CaptureRequested,
            shortcut::ShortcutStatus,
            first_run::AutostartChanged,
            history::HistoryChanged,
            editor::EditorImageChanged
        ])
        .error_handling(ErrorHandlingMode::Result)
}

/// Where the generated TypeScript bindings live (committed to the repo).
fn bindings_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/bindings.ts")
}

fn export_bindings(builder: &tauri_specta::Builder<tauri::Wry>, path: &std::path::Path) {
    builder
        .export(specta_typescript::Typescript::default(), path)
        .expect("failed to export TypeScript bindings");
}

/// Starts the tray app and blocks until it exits.
///
/// # Panics
///
/// If Tauri cannot build the app (bad config, WebView2 missing), since there
/// is no window yet to report the error in.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    export_bindings(&builder, &bindings_path());

    let app = tauri::Builder::default()
        // Must be first: a second launch hands over to the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            app_windows::show(app, app_windows::EDITOR);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

            let settings_path = app.path().app_config_dir()?.join(settings::FILE_NAME);
            let loaded = settings::load(&settings_path);
            // Windows created later inherit this theme.
            app.set_theme(loaded.theme.to_tauri());
            app.manage(AppState::new(settings_path, loaded));
            app.manage(app_windows::CloseTimers::default());
            app.manage(editor::EditorImage::default());
            app.manage(export::SavedFiles::default());
            app.manage(history::History::new(
                app.path().app_local_data_dir()?.join("history"),
            ));
            app.manage(presets::UserPresets::new(
                app.path().app_config_dir()?.join(presets::FILE_NAME),
            ));
            // Captures past their 30 days go even when nothing new is captured.
            std::thread::spawn({
                let app = app.handle().clone();
                move || {
                    app.state::<history::History>()
                        .prune(std::time::SystemTime::now());
                }
            });

            let lang = i18n::Lang::detect();
            tray::create(app.handle(), lang)?;

            let status = shortcut::register_from_settings(app.handle());
            if !status.registered {
                // Tell the user right away instead of failing silently.
                app_windows::show(app.handle(), app_windows::SETTINGS);
            }
            first_run::ask_autostart_once(app.handle(), lang);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Cropa lives in the tray: closing a window hides it, and it is
            // destroyed a few minutes later unless reopened.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                app_windows::hide_then_destroy(window);
            }
            // The theme setting or the Windows mode changed.
            WindowEvent::ThemeChanged(theme) => {
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                    app_windows::paint_background(&webview, *theme);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building Cropa");

    app.run(|_app, event| {
        // Keep running with no visible window; only the tray's Quit exits.
        if let RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            api.prevent_exit();
        }
    });
}

#[cfg(test)]
mod tests {
    /// CI guard: the committed `bindings.ts` must match the Rust command surface.
    /// `pnpm bindings` runs this test with `CROPA_WRITE_BINDINGS=1`, which writes
    /// the file instead of comparing (no window needed).
    #[test]
    fn bindings_are_up_to_date() {
        if std::env::var_os("CROPA_WRITE_BINDINGS").is_some() {
            super::export_bindings(&super::specta_builder(), &super::bindings_path());
            return;
        }
        let fresh = std::env::temp_dir().join(format!("cropa-bindings-{}.ts", std::process::id()));
        super::export_bindings(&super::specta_builder(), &fresh);
        let normalize = |s: String| s.replace("\r\n", "\n");
        let expected = normalize(std::fs::read_to_string(&fresh).unwrap());
        let _ = std::fs::remove_file(&fresh);
        let committed = normalize(
            std::fs::read_to_string(super::bindings_path())
                .expect("src/lib/bindings.ts is missing; run `pnpm bindings`"),
        );
        assert!(
            expected == committed,
            "src/lib/bindings.ts is stale; run `pnpm bindings` and commit it"
        );
    }
}
