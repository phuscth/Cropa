//! Cropa desktop: the thin layer that wires Tauri to the platform code and
//! the pure crates (ROADMAP §3).

mod app_windows;
mod capture;
mod commands;
mod i18n;
mod platform;
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
            commands::settings::get_autostart,
            commands::settings::set_autostart,
        ])
        .events(collect_events![
            capture::CaptureRequested,
            shortcut::ShortcutStatus
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
            app.manage(AppState::new(settings_path, loaded));
            app.manage(app_windows::CloseTimers::default());

            tray::create(app.handle(), i18n::Lang::detect())?;

            let status = shortcut::register_from_settings(app.handle());
            if !status.registered {
                // Tell the user right away instead of failing silently.
                app_windows::show(app.handle(), app_windows::SETTINGS);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Cropa lives in the tray: closing a window hides it, and it is
            // destroyed a few minutes later unless reopened (D28).
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                app_windows::hide_then_destroy(window);
            }
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
