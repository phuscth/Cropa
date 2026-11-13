//! Hook for the end-to-end smoke tests. Only debug builds read the variables:
//! in a release build `from_env` is always `None`, so they do nothing.
//!
//! - `CROPA_E2E_DIR`: run as a separate instance whose settings, history,
//!   presets, logs and WebView data all live under this absolute folder, and
//!   which never touches the user's own Cropa or its start-with-Windows entry.
//! - `CROPA_E2E_EDITOR_IMAGE`: a PNG file opened in the editor at startup
//!   (only read together with `CROPA_E2E_DIR`).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Context, Manager, Runtime};
use tauri_plugin_log::{Target, TargetKind};

/// The app identifier of a test instance. The single-instance plugin names its
/// mutex and window after the identifier, so a test instance never hands over
/// to, or blocks, the user's running Cropa.
pub const IDENTIFIER: &str = "cropa-e2e";

pub struct E2e {
    dir: PathBuf,
    editor_image: Option<PathBuf>,
}

impl E2e {
    pub fn config_dir(&self) -> PathBuf {
        self.dir.join("config")
    }

    pub fn local_data_dir(&self) -> PathBuf {
        self.dir.join("local")
    }

    pub fn log_dir(&self) -> PathBuf {
        self.dir.join("logs")
    }

    pub fn webview_dir(&self) -> PathBuf {
        self.dir.join("webview")
    }

    pub fn editor_image(&self) -> Option<&Path> {
        self.editor_image.as_deref()
    }
}

/// The test hook, when this is a debug build started with `CROPA_E2E_DIR`.
#[cfg(debug_assertions)]
pub fn from_env() -> Option<E2e> {
    let dir = PathBuf::from(std::env::var_os("CROPA_E2E_DIR")?);
    // A relative folder would depend on the working directory of whoever
    // started the app. Falling back to the real instance would touch real
    // data, so refuse to start.
    assert!(dir.is_absolute(), "CROPA_E2E_DIR must be an absolute path");
    let editor_image = std::env::var_os("CROPA_E2E_EDITOR_IMAGE").map(PathBuf::from);
    Some(E2e { dir, editor_image })
}

#[cfg(not(debug_assertions))]
pub fn from_env() -> Option<E2e> {
    None
}

/// Give a test instance its own identifier.
pub fn apply_to_context<R: Runtime>(e2e: Option<&E2e>, context: &mut Context<R>) {
    if e2e.is_some() {
        IDENTIFIER.clone_into(&mut context.config_mut().identifier);
    }
}

/// The log plugin: a test instance also logs to its own folder, so the files
/// can be printed when a test fails.
pub fn log_plugin<R: Runtime>(e2e: Option<&E2e>) -> tauri::plugin::TauriPlugin<R> {
    let mut log = tauri_plugin_log::Builder::new().level(log::LevelFilter::Info);
    if let Some(e2e) = e2e {
        log = log.clear_targets().targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::Folder {
                path: e2e.log_dir(),
                file_name: None,
            }),
        ]);
    }
    log.build()
}

/// Called at the end of setup in a test instance (instead of the autostart
/// question, which is a modal dialog and touches the autostart entry): open the
/// test image in the editor, if there is one.
pub fn open_editor_image<R: Runtime>(app: &AppHandle<R>) {
    let Some(path) = app.state::<E2e>().editor_image().map(Path::to_path_buf) else {
        return;
    };
    match std::fs::read(&path) {
        Ok(png) => crate::editor::open(app, png),
        Err(err) => log::warn!("could not read the editor test image: {err}"),
    }
}
