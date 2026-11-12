//! User settings persisted as versioned JSON in the app config directory.
//! Every file on disk carries `version` and goes through [`migrate`] (ROADMAP §3.2).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

pub const CURRENT_VERSION: u32 = 1;
pub const DEFAULT_CAPTURE_SHORTCUT: &str = "Alt+Shift+S";
pub const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    /// Global shortcut for region capture, in Tauri accelerator syntax.
    pub capture_shortcut: String,
    /// Start Cropa when the user signs in. Off by default.
    pub autostart: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            capture_shortcut: DEFAULT_CAPTURE_SHORTCUT.to_owned(),
            autostart: false,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error("settings file has no numeric `version`")]
    MissingVersion,
    #[error("settings version {0} is newer than this build understands")]
    TooNew(u64),
    #[error("settings file is malformed: {0}")]
    Malformed(#[from] serde_json::Error),
}

/// Bring any known on-disk version up to [`CURRENT_VERSION`].
pub fn migrate(value: serde_json::Value) -> Result<Settings, MigrateError> {
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or(MigrateError::MissingVersion)?;
    match version {
        1 => Ok(serde_json::from_value(value)?),
        other => Err(MigrateError::TooNew(other)),
    }
}

/// Load settings from `path`. A missing file gives defaults. An unreadable or
/// invalid file is moved aside to `<name>.bak` and defaults are used, so a bad
/// file never stops the app from starting.
pub fn load(path: &Path) -> Settings {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Settings::default(),
        Err(err) => {
            log::warn!("could not read settings: {err}");
            return Settings::default();
        }
    };
    let parsed = serde_json::from_str(&raw)
        .map_err(MigrateError::from)
        .and_then(migrate);
    match parsed {
        Ok(settings) => settings,
        Err(err) => {
            log::warn!("settings reset to defaults: {err}");
            if let Err(err) = fs::rename(path, backup_path(path)) {
                log::warn!("could not back up the old settings file: {err}");
            }
            Settings::default()
        }
    }
}

/// Write settings atomically: a temp file next to the target, then rename.
pub fn save(path: &Path, settings: &Settings) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, path)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "cropa-settings-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = TempDir::new("missing");
        assert_eq!(load(&dir.0.join(FILE_NAME)), Settings::default());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = TempDir::new("roundtrip");
        let path = dir.0.join("nested").join(FILE_NAME);
        let settings = Settings {
            capture_shortcut: "Ctrl+Shift+2".into(),
            autostart: true,
            ..Settings::default()
        };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);
    }

    #[test]
    fn corrupt_file_is_backed_up_and_defaults_used() {
        let dir = TempDir::new("corrupt");
        let path = dir.0.join(FILE_NAME);
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), Settings::default());
        assert!(dir.0.join("settings.json.bak").exists());
        assert!(!path.exists());
    }

    #[test]
    fn migrate_rejects_unknown_versions() {
        let too_new = serde_json::json!({ "version": 99 });
        assert!(matches!(migrate(too_new), Err(MigrateError::TooNew(99))));
        let unversioned = serde_json::json!({ "captureShortcut": "Alt+S" });
        assert!(matches!(
            migrate(unversioned),
            Err(MigrateError::MissingVersion)
        ));
    }

    #[test]
    fn default_shortcut_matches_d13() {
        assert_eq!(Settings::default().capture_shortcut, "Alt+Shift+S");
        assert!(!Settings::default().autostart);
    }
}
