//! User settings persisted as versioned JSON in the app config directory.
//! Every file on disk carries `version` and goes through [`migrate`].

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

pub const CURRENT_VERSION: u32 = 6;
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

/// The AI provider every AI task goes through. On disk: `"codex"`, `"claude"`
/// or `"mock"`; the mock is a test provider that exists in debug builds only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiProvider {
    Codex,
    Claude,
    Mock,
}

/// How much thinking an AI task may spend. Higher is slower and uses more of the user's
/// quota. On disk: `"low"`, `"medium"` or `"high"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiEffort {
    #[default]
    Low,
    Medium,
    High,
}

/// AI choices. The login itself is never stored: Cropa uses the CLI the user
/// installed and logged in to.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// The provider chosen by the user; `None` until one is chosen or after
    /// AI is turned off.
    #[serde(deserialize_with = "known_provider")]
    #[specta(type = Option<AiProvider>)]
    pub provider: Option<AiProvider>,
    /// Whether a task may send screenshots to the provider (each send is also
    /// confirmed).
    pub allow_images: bool,
    /// The effort tasks run with; the last choice the user made.
    #[serde(deserialize_with = "known_effort")]
    #[specta(type = AiEffort)]
    pub effort: AiEffort,
    /// Whether the first-launch AI question has been answered or dismissed.
    pub onboarding_answered: bool,
}

/// A provider this build does not know (a file from a newer build) loads as
/// none, so the rest of the file is kept.
fn known_provider<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AiProvider>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

/// An effort this build does not know (a file from a newer build) loads as low, so the rest of
/// the file is kept.
fn known_effort<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<AiEffort, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// `"ai": null` loads as the defaults.
fn ai_or_default<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<AiSettings, D::Error> {
    Ok(Option::<AiSettings>::deserialize(deserializer)?.unwrap_or_default())
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
    /// Whether the first-launch "Start with Windows?" question has been answered.
    pub autostart_asked: bool,
    /// Whether each capture is also kept in the history folder.
    pub save_history: bool,
    /// Whether captures are kept out of Windows clipboard history and cloud sync.
    pub exclude_from_clipboard_history: bool,
    /// Folder that Ctrl+S saves into; `None` until the user picks one.
    pub save_folder: Option<PathBuf>,
    /// The provider shared by all AI tasks, whether images may be sent to it,
    /// and whether the first-launch AI question was answered.
    #[serde(deserialize_with = "ai_or_default")]
    #[specta(type = AiSettings)]
    pub ai: AiSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            capture_shortcut: DEFAULT_CAPTURE_SHORTCUT.to_owned(),
            theme: ThemePreference::default(),
            autostart_asked: false,
            save_history: true,
            exclude_from_clipboard_history: false,
            save_folder: None,
            ai: AiSettings::default(),
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
/// user's file away. A field whose meaning changes, or whose default differs
/// for existing files, needs a new version and a step here.
pub fn migrate(value: serde_json::Value) -> Result<Settings, MigrateError> {
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or(MigrateError::MissingVersion)?;
    match version {
        1 => over_defaults(v5_to_v6(v4_to_v5(v3_to_v4(v2_to_v3(v1_to_v2(value)))))),
        2 => over_defaults(v5_to_v6(v4_to_v5(v3_to_v4(v2_to_v3(value))))),
        3 => over_defaults(v5_to_v6(v4_to_v5(v3_to_v4(value)))),
        4 => over_defaults(v5_to_v6(v4_to_v5(value))),
        5 => over_defaults(v5_to_v6(value)),
        6 => over_defaults(value),
        other => Err(MigrateError::TooNew(other)),
    }
}

/// A version 1 file is only written from the Settings view, which already
/// shows the start-at-login toggle, so that user has seen the choice and is not
/// asked again at launch.
fn v1_to_v2(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(file) = value.as_object_mut() {
        file.insert("version".into(), 2.into());
        file.entry("autostartAsked").or_insert(true.into());
    }
    value
}

/// History saving was introduced in version 3 and is on for existing files.
fn v2_to_v3(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(file) = value.as_object_mut() {
        file.insert("version".into(), 3.into());
        file.entry("saveHistory").or_insert(true.into());
        file.entry("excludeFromClipboardHistory")
            .or_insert(false.into());
    }
    value
}

/// The save folder was introduced in version 4; it starts unset, so Cropa asks
/// the first time the user saves.
fn v3_to_v4(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(file) = value.as_object_mut() {
        file.insert("version".into(), 4.into());
        file.entry("saveFolder").or_insert(serde_json::Value::Null);
    }
    value
}

/// AI settings were introduced in version 5. Existing users have not been asked
/// about AI yet, so they are asked once.
fn v4_to_v5(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(file) = value.as_object_mut() {
        file.insert("version".into(), 5.into());
        file.entry("ai").or_insert(serde_json::json!({
            "provider": null,
            "allowImages": false,
            "onboardingAnswered": false
        }));
    }
    value
}

/// The AI effort was introduced in version 6; every existing file starts on low, which is what
/// both adapters used before it could be chosen.
fn v5_to_v6(mut value: serde_json::Value) -> serde_json::Value {
    if let Some(file) = value.as_object_mut() {
        file.insert("version".into(), 6.into());
        if let Some(ai) = file
            .get_mut("ai")
            .and_then(serde_json::Value::as_object_mut)
        {
            ai.entry("effort").or_insert("low".into());
        }
    }
    value
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
        Ok(settings) => without_mock_provider(settings),
        Err(err) => {
            log::warn!("settings reset to defaults: {err}");
            if let Err(err) = fs::rename(path, backup_path(path)) {
                log::warn!("could not back up the old settings file: {err}");
            }
            Settings::default()
        }
    }
}

/// The mock provider exists in debug builds only; a release build drops it.
#[cfg_attr(debug_assertions, allow(unused_mut))]
fn without_mock_provider(mut settings: Settings) -> Settings {
    #[cfg(not(debug_assertions))]
    if settings.ai.provider == Some(AiProvider::Mock) {
        settings.ai.provider = None;
    }
    settings
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
            autostart_asked: true,
            save_history: false,
            exclude_from_clipboard_history: true,
            save_folder: Some(PathBuf::from("D:/Pictures/Cropa")),
            ai: AiSettings {
                provider: Some(AiProvider::Codex),
                allow_images: true,
                effort: AiEffort::High,
                onboarding_answered: true,
            },
            ..Settings::default()
        };
        save(&path, &settings).unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["theme"], "dark");
        assert_eq!(on_disk["version"], 6);
        assert_eq!(on_disk["ai"]["effort"], "high");
        assert_eq!(on_disk["ai"]["provider"], "codex");
        assert_eq!(on_disk["ai"]["allowImages"], true);
        assert_eq!(on_disk["ai"]["onboardingAnswered"], true);
        assert_eq!(on_disk["autostartAsked"], true);
        assert_eq!(on_disk["saveHistory"], false);
        assert_eq!(on_disk["excludeFromClipboardHistory"], true);
        assert_eq!(on_disk["saveFolder"], "D:/Pictures/Cropa");
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
            serde_json::json!({ "version": 4, "captureShortcut": "Ctrl+Alt+P", "autostart": true });
        let migrated = migrate(old).unwrap();
        assert_eq!(migrated.capture_shortcut, "Ctrl+Alt+P");
        assert_eq!(migrated.theme, ThemePreference::System);
        // A file written before a field existed gets that field's default.
        let sparse = serde_json::json!({ "version": 4 });
        assert_eq!(migrate(sparse).unwrap(), Settings::default());
    }

    #[test]
    fn a_version_1_file_migrates_and_is_not_asked_again() {
        let with_theme = serde_json::json!({
            "version": 1, "captureShortcut": "Ctrl+Alt+P", "theme": "light", "autostart": true
        });
        let migrated = migrate(with_theme).unwrap();
        assert_eq!(migrated.version, 6);
        assert!(migrated.autostart_asked);
        assert!(migrated.save_history);
        assert_eq!(migrated.capture_shortcut, "Ctrl+Alt+P");
        assert_eq!(migrated.theme, ThemePreference::Light);

        let without_theme = serde_json::json!({ "version": 1, "captureShortcut": "Ctrl+Alt+P" });
        let migrated = migrate(without_theme).unwrap();
        assert!(migrated.autostart_asked);
        assert_eq!(migrated.theme, ThemePreference::System);
    }

    #[test]
    fn a_version_2_file_migrates_to_6_and_keeps_its_fields() {
        let v2 = serde_json::json!({
            "version": 2, "captureShortcut": "Ctrl+Alt+P", "theme": "dark", "autostartAsked": false
        });
        let migrated = migrate(v2).unwrap();
        assert_eq!(migrated.version, 6);
        assert!(migrated.save_history);
        assert!(!migrated.exclude_from_clipboard_history);
        assert_eq!(migrated.capture_shortcut, "Ctrl+Alt+P");
        assert_eq!(migrated.theme, ThemePreference::Dark);
        assert!(!migrated.autostart_asked);
    }

    #[test]
    fn a_version_3_file_keeps_history_off() {
        let off = serde_json::json!({ "version": 3, "saveHistory": false });
        assert!(!migrate(off).unwrap().save_history);
    }

    #[test]
    fn a_version_3_file_keeps_clipboard_privacy_on() {
        let on = serde_json::json!({ "version": 3, "excludeFromClipboardHistory": true });
        assert!(migrate(on).unwrap().exclude_from_clipboard_history);
    }

    #[test]
    fn a_version_3_file_migrates_to_6_without_a_save_folder() {
        let v3 = serde_json::json!({
            "version": 3, "captureShortcut": "Ctrl+Alt+P", "theme": "dark",
            "autostartAsked": true, "saveHistory": false, "excludeFromClipboardHistory": true
        });
        let migrated = migrate(v3).unwrap();
        assert_eq!(migrated.version, 6);
        assert_eq!(migrated.save_folder, None);
        assert_eq!(migrated.capture_shortcut, "Ctrl+Alt+P");
        assert_eq!(migrated.theme, ThemePreference::Dark);
        assert!(migrated.autostart_asked);
        assert!(!migrated.save_history);
        assert!(migrated.exclude_from_clipboard_history);
    }

    #[test]
    fn a_version_4_file_keeps_its_save_folder() {
        let v4 = serde_json::json!({ "version": 4, "saveFolder": "D:/Pictures/Cropa" });
        assert_eq!(
            migrate(v4).unwrap().save_folder,
            Some(PathBuf::from("D:/Pictures/Cropa"))
        );
    }

    #[test]
    fn a_version_4_file_migrates_to_6_and_asks_about_ai_once() {
        let v4 = serde_json::json!({
            "version": 4, "captureShortcut": "Ctrl+Alt+P", "theme": "dark",
            "saveFolder": "D:/Pictures/Cropa"
        });
        let migrated = migrate(v4).unwrap();
        assert_eq!(migrated.version, 6);
        assert_eq!(migrated.ai, AiSettings::default());
        assert!(!migrated.ai.onboarding_answered);
        assert_eq!(migrated.capture_shortcut, "Ctrl+Alt+P");
        assert_eq!(migrated.theme, ThemePreference::Dark);
        assert_eq!(
            migrated.save_folder,
            Some(PathBuf::from("D:/Pictures/Cropa"))
        );
    }

    #[test]
    fn a_version_5_file_keeps_its_ai_choices() {
        let v5 = serde_json::json!({
            "version": 5,
            "ai": { "provider": "claude", "allowImages": true, "onboardingAnswered": true }
        });
        let ai = migrate(v5).unwrap().ai;
        assert_eq!(ai.provider, Some(AiProvider::Claude));
        assert!(ai.allow_images);
        assert!(ai.onboarding_answered);
    }

    #[test]
    fn the_v5_to_v6_step_writes_low_effort_and_keeps_the_other_ai_fields() {
        // On the JSON itself, before any deserialising fills in a default.
        let v5 = serde_json::json!({
            "version": 5,
            "ai": { "provider": "claude", "allowImages": true, "onboardingAnswered": true }
        });
        let step = v5_to_v6(v5);
        assert_eq!(step["version"], 6);
        assert_eq!(
            step["ai"],
            serde_json::json!({
                "provider": "claude", "allowImages": true, "onboardingAnswered": true,
                "effort": "low"
            })
        );

        let chosen = v5_to_v6(serde_json::json!({ "version": 5, "ai": { "effort": "high" } }));
        assert_eq!(chosen["ai"]["effort"], "high");
    }

    #[test]
    fn a_version_5_file_gets_low_effort_and_a_chosen_effort_is_kept() {
        let v5 = serde_json::json!({
            "version": 5,
            "ai": { "provider": "claude", "allowImages": true, "onboardingAnswered": true }
        });
        let migrated = migrate(v5).unwrap();
        assert_eq!(migrated.version, 6);
        assert_eq!(migrated.ai.effort, AiEffort::Low);
        assert_eq!(migrated.ai.provider, Some(AiProvider::Claude));

        let v6 = serde_json::json!({ "version": 6, "ai": { "effort": "high" } });
        assert_eq!(migrate(v6).unwrap().ai.effort, AiEffort::High);
    }

    #[test]
    fn an_unknown_effort_loads_as_low_and_keeps_the_rest() {
        let file = serde_json::json!({
            "version": 6, "theme": "dark", "ai": { "effort": "max", "allowImages": true }
        });
        let migrated = migrate(file).unwrap();
        assert_eq!(migrated.ai.effort, AiEffort::Low);
        assert!(migrated.ai.allow_images);
        assert_eq!(migrated.theme, ThemePreference::Dark);
    }

    #[test]
    fn a_partial_ai_object_keeps_what_it_has_and_defaults_the_rest() {
        let partial = serde_json::json!({ "version": 5, "ai": { "provider": "codex" } });
        let ai = migrate(partial).unwrap().ai;
        assert_eq!(ai.provider, Some(AiProvider::Codex));
        assert!(!ai.allow_images);
        assert!(!ai.onboarding_answered);
    }

    #[test]
    fn an_unknown_provider_loads_as_none_and_keeps_the_rest() {
        let file = serde_json::json!({
            "version": 5, "captureShortcut": "Ctrl+Alt+P",
            "ai": { "provider": "gemini", "allowImages": true, "onboardingAnswered": true }
        });
        let migrated = migrate(file).unwrap();
        assert_eq!(migrated.ai.provider, None);
        assert!(migrated.ai.allow_images);
        assert!(migrated.ai.onboarding_answered);
        assert_eq!(migrated.capture_shortcut, "Ctrl+Alt+P");
    }

    #[test]
    fn a_null_ai_object_loads_as_the_defaults_and_keeps_the_rest() {
        let file = serde_json::json!({ "version": 5, "theme": "dark", "ai": null });
        let migrated = migrate(file).unwrap();
        assert_eq!(migrated.ai, AiSettings::default());
        assert_eq!(migrated.theme, ThemePreference::Dark);
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn a_release_build_drops_the_mock_provider_on_load() {
        let dir = TempDir::new("mock");
        let path = dir.0.join(FILE_NAME);
        fs::write(&path, r#"{ "version": 5, "ai": { "provider": "mock" } }"#).unwrap();
        assert_eq!(load(&path).ai.provider, None);
    }

    #[test]
    fn a_newer_version_is_rejected() {
        assert!(matches!(
            migrate(serde_json::json!({ "version": 7 })),
            Err(MigrateError::TooNew(7))
        ));
    }

    #[test]
    fn a_file_missing_a_field_is_not_backed_up() {
        let dir = TempDir::new("sparse");
        let path = dir.0.join(FILE_NAME);
        fs::write(&path, r#"{ "version": 4 }"#).unwrap();
        assert_eq!(load(&path), Settings::default());
        assert!(path.exists());
        assert!(!dir.0.join("settings.json.bak").exists());
    }
}
