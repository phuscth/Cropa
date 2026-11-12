//! User settings persisted as versioned JSON in the app config directory.
//! Every file on disk carries `version` and goes through [`migrate`].

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

pub const CURRENT_VERSION: u32 = 1;
pub const DEFAULT_CAPTURE_SHORTCUT: &str = "Alt+Shift+S";
pub const FILE_NAME: &str = "settings.json";

/// Colour theme of every window. On disk: `"system"`, `"light"` or `"dark"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    /// Follow the light or dark mode set in Windows.
    #[default]
    System,
    Light,
    Dark,
}

impl ThemePreference {
    /// The theme to hand to Tauri; `None` follows the operating system.
    #[must_use]
    pub fn to_tauri(self) -> Option<tauri::Theme> {
        match self {
            Self::System => None,
            Self::Light => Some(tauri::Theme::Light),
            Self::Dark => Some(tauri::Theme::Dark),
        }
    }
}

/// Start-at-login is not stored here: Windows is the only source of truth for it
/// (see `commands::settings::get_autostart`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    /// Global shortcut for region capture, in Tauri accelerator syntax.
    pub capture_shortcut: String,
    /// Colour theme; a file written before this field existed gets `System`.
    pub theme: ThemePreference,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            capture_shortcut: DEFAULT_CAPTURE_SHORTCUT.to_owned(),
            theme: ThemePreference::default(),
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
///
/// Within a version, the file is laid over the defaults: a field the file lacks
/// (added later) takes its default and a field this build does not know
/// (removed later) is dropped, so adding or removing a field never throws the
/// user's file away. A field whose meaning changes needs a new version and a
/// step here.
pub fn migrate(value: serde_json::Value) -> Result<Settings, MigrateError> {
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or(MigrateError::MissingVersion)?;
    match version {
        1 => over_defaults(value),
        other => Err(MigrateError::TooNew(other)),
    }
}

fn over_defaults(file: serde_json::Value) -> Result<Settings, MigrateError> {
    let mut merged = serde_json::to_value(Settings::default())?;
    if let (Some(base), serde_json::Value::Object(file)) = (merged.as_object_mut(), file) {
        for (key, value) in file {
            if let Some(slot) = base.get_mut(&key) {
                *slot = value;
            }
        }
    }
    Ok(serde_json::from_value(merged)?)
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
            theme: ThemePreference::Dark,
            ..Settings::default()
        };
        save(&path, &settings).unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["theme"], "dark");
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
    fn default_shortcut_is_alt_shift_s() {
        assert_eq!(Settings::default().capture_shortcut, "Alt+Shift+S");
    }

    #[test]
    fn missing_and_unknown_fields_keep_the_rest() {
        // A file from a build that had a field this one dropped (`autostart`).
        let old =
            serde_json::json!({ "version": 1, "captureShortcut": "Ctrl+Alt+P", "autostart": true });
        let migrated = migrate(old).unwrap();
        assert_eq!(migrated.capture_shortcut, "Ctrl+Alt+P");
        assert_eq!(migrated.theme, ThemePreference::System);
        // A file written before a field existed gets that field's default.
        let sparse = serde_json::json!({ "version": 1 });
        assert_eq!(migrate(sparse).unwrap(), Settings::default());
    }

    #[test]
    fn a_file_missing_a_field_is_not_backed_up() {
        let dir = TempDir::new("sparse");
        let path = dir.0.join(FILE_NAME);
        fs::write(&path, r#"{ "version": 1 }"#).unwrap();
        assert_eq!(load(&path), Settings::default());
        assert!(path.exists());
        assert!(!dir.0.join("settings.json.bak").exists());
    }
}
