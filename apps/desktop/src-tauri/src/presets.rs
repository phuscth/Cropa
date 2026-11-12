//! The backgrounds a user saved as presets, kept as versioned JSON in the app
//! config directory. Every file on disk carries `version` and goes through
//! [`migrate`].
//!
//! The WebView validates a background against the full schema before it calls
//! in; this module checks what it can without knowing that schema (shape, size,
//! counts) so a bad call cannot fill the disk or break the file.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;

pub const CURRENT_VERSION: u32 = 1;
pub const FILE_NAME: &str = "presets.json";
/// The same limit `@cropa/core` puts on a preset file.
pub const MAX_BACKGROUND_BYTES: usize = 16384;
pub const MAX_PRESETS: usize = 200;
const MAX_NAME_CHARS: usize = 40;
const MAX_LAYERS: usize = 16;

/// One saved background. `background` is the JSON of `@cropa/core`'s `BackgroundSpec`;
/// the bindings type it as `unknown` and the WebView validates it with that schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserPreset {
    pub id: String,
    pub name: String,
    #[specta(type = specta_typescript::Unknown)]
    pub background: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPresetsFile {
    pub version: u32,
    pub presets: Vec<UserPreset>,
}

impl Default for UserPresetsFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            presets: Vec::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error("presets file has no numeric `version`")]
    MissingVersion,
    #[error("presets version {0} is newer than this build understands")]
    TooNew(u64),
    #[error("presets file is malformed: {0}")]
    Malformed(#[from] serde_json::Error),
}

/// Bring any known on-disk version up to [`CURRENT_VERSION`]. Only version 1 exists.
pub fn migrate(value: serde_json::Value) -> Result<UserPresetsFile, MigrateError> {
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or(MigrateError::MissingVersion)?;
    match version {
        1 => Ok(serde_json::from_value(value)?),
        other => Err(MigrateError::TooNew(other)),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PresetsError {
    #[error("the preset name must have 1 to {MAX_NAME_CHARS} characters and no control characters")]
    Name,
    #[error("the background is not valid: {0}")]
    Invalid(String),
    #[error("the background is over {MAX_BACKGROUND_BYTES} bytes")]
    TooLarge,
    #[error("there are already {MAX_PRESETS} presets")]
    Full,
    #[error("that preset does not exist")]
    Missing,
    #[error("the presets file was written by a newer version of Cropa")]
    TooNew,
    #[error("could not read the presets file: {0}")]
    Read(String),
    #[error("could not save the presets file: {0}")]
    Save(String),
}

/// `<name>.bak`, else `<name>.bak.1`, `.2`, ...: the first that does not exist, so
/// a backup never replaces an earlier one.
fn backup_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_os_string();
    let with_suffix = |suffix: &str| {
        let mut name = name.clone();
        name.push(suffix);
        path.with_file_name(name)
    };
    let first = with_suffix(".bak");
    if !first.exists() {
        return first;
    }
    (1..=10_000)
        .map(|n| with_suffix(&format!(".bak.{n}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or(first)
}

/// Load the presets at `path`. A missing file is an empty list. A file that is
/// malformed or has no version is moved aside to `<name>.bak` and the list is
/// empty, so a bad file never blocks saving new presets. A file from a newer
/// build is an error and stays where it is.
fn load(path: &Path) -> Result<UserPresetsFile, PresetsError> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(UserPresetsFile::default()),
        Err(err) => return Err(PresetsError::Read(err.to_string())),
    };
    let parsed = serde_json::from_slice(&raw)
        .map_err(MigrateError::from)
        .and_then(migrate);
    match parsed {
        Ok(file) => Ok(file),
        Err(MigrateError::TooNew(_)) => Err(PresetsError::TooNew),
        Err(err) => {
            log::warn!("presets reset to an empty list: {err}");
            // If the file cannot be set aside, stop: the next save would replace it.
            fs::rename(path, backup_path(path)).map_err(|err| {
                PresetsError::Read(format!("could not back up the old file: {err}"))
            })?;
            Ok(UserPresetsFile::default())
        }
    }
}

/// Write atomically: a temp file next to the target, then rename.
fn write(path: &Path, file: &UserPresetsFile) -> Result<(), PresetsError> {
    let save = || -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
        let tmp = path.with_extension("json.tmp");
        let mut out = fs::File::create(&tmp)?;
        out.write_all(&json)?;
        out.sync_all()?;
        drop(out);
        fs::rename(&tmp, path)
    };
    save().map_err(|err| PresetsError::Save(err.to_string()))
}

/// The name as stored: trimmed, 1 to 40 characters, no control characters.
fn clean_name(name: &str) -> Result<String, PresetsError> {
    let name = name.trim();
    let length = name.chars().count();
    if length == 0 || length > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(PresetsError::Name);
    }
    Ok(name.to_owned())
}

fn check_background(background: &serde_json::Value) -> Result<(), PresetsError> {
    let invalid = |why: &str| Err(PresetsError::Invalid(why.to_owned()));
    let Some(object) = background.as_object() else {
        return invalid("expected an object");
    };
    if object
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .is_none_or(|v| v < 1)
    {
        return invalid("version: expected a positive integer");
    }
    let Some(layers) = object.get("layers").and_then(serde_json::Value::as_array) else {
        return invalid("layers: expected a list");
    };
    if layers.is_empty() || layers.len() > MAX_LAYERS {
        return invalid("layers: expected 1 to 16 layers");
    }
    if !layers
        .iter()
        .all(|layer| layer.get("type").is_some_and(serde_json::Value::is_string))
    {
        return invalid("layers: every layer needs a type");
    }
    let size = serde_json::to_vec(background).map_or(usize::MAX, |bytes| bytes.len());
    if size > MAX_BACKGROUND_BYTES {
        return Err(PresetsError::TooLarge);
    }
    Ok(())
}

/// `user-<hex of nanoseconds since the epoch>`, bumped until no preset has it.
fn new_id(existing: &[UserPreset]) -> String {
    let mut nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    loop {
        let id = format!("user-{nanos:x}");
        if !existing.iter().any(|p| p.id == id) {
            return id;
        }
        nanos += 1;
    }
}

/// The user's presets on disk. One lock covers each read-modify-write.
pub struct UserPresets {
    path: PathBuf,
    lock: Mutex<()>,
}

impl UserPresets {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn list(&self) -> Result<Vec<UserPreset>, PresetsError> {
        let _guard = self.guard();
        Ok(load(&self.path)?.presets)
    }

    /// `None` adds a new preset; `Some(id)` replaces that preset in place.
    pub fn save(
        &self,
        id: Option<&str>,
        name: &str,
        background: serde_json::Value,
    ) -> Result<UserPreset, PresetsError> {
        let name = clean_name(name)?;
        check_background(&background)?;
        let _guard = self.guard();
        let mut file = load(&self.path)?;
        let saved = if let Some(id) = id {
            let slot = file
                .presets
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or(PresetsError::Missing)?;
            slot.name = name;
            slot.background = background;
            slot.clone()
        } else {
            if file.presets.len() >= MAX_PRESETS {
                return Err(PresetsError::Full);
            }
            let preset = UserPreset {
                id: new_id(&file.presets),
                name,
                background,
            };
            file.presets.push(preset.clone());
            preset
        };
        write(&self.path, &file)?;
        Ok(saved)
    }

    /// Deleting a preset that is not there is not an error.
    pub fn delete(&self, id: &str) -> Result<(), PresetsError> {
        let _guard = self.guard();
        let mut file = load(&self.path)?;
        let before = file.presets.len();
        file.presets.retain(|p| p.id != id);
        if file.presets.len() == before {
            return Ok(());
        }
        write(&self.path, &file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "cropa-presets-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn presets(&self) -> UserPresets {
            UserPresets::new(self.0.join(FILE_NAME))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn background() -> serde_json::Value {
        json!({
            "version": 1,
            "viewBox": [0, 0, 1000, 1000],
            "layers": [{ "type": "solid", "color": "#112233" }],
            "animation": { "type": "none", "speed": 1, "loop": true, "durationMs": 4000 }
        })
    }

    #[test]
    fn migrate_reads_version_1_and_rejects_the_rest() {
        let file = json!({ "version": 1, "presets": [] });
        assert_eq!(migrate(file).unwrap(), UserPresetsFile::default());
        assert!(matches!(
            migrate(json!({ "presets": [] })),
            Err(MigrateError::MissingVersion)
        ));
        assert!(matches!(
            migrate(json!({ "version": 2, "presets": [] })),
            Err(MigrateError::TooNew(2))
        ));
        assert!(matches!(
            migrate(json!({ "version": 1, "presets": "no" })),
            Err(MigrateError::Malformed(_))
        ));
    }

    #[test]
    fn a_missing_file_is_an_empty_list() {
        let dir = TempDir::new("missing");
        assert_eq!(dir.presets().list().unwrap(), Vec::new());
    }

    #[test]
    fn save_then_list_round_trips_through_the_file() {
        let dir = TempDir::new("roundtrip");
        let presets = dir.presets();
        let saved = presets.save(None, "  Warm  ", background()).unwrap();
        assert!(saved.id.starts_with("user-"));
        assert_eq!(saved.name, "Warm");
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.0.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(on_disk["version"], 1);
        assert_eq!(on_disk["presets"][0]["background"], background());
        // A fresh handle reads what the first one wrote.
        assert_eq!(dir.presets().list().unwrap(), vec![saved]);
    }

    #[test]
    fn replacing_keeps_order_and_id() {
        let dir = TempDir::new("replace");
        let presets = dir.presets();
        let first = presets.save(None, "One", background()).unwrap();
        let second = presets.save(None, "Two", background()).unwrap();
        assert_ne!(first.id, second.id);
        let mut other = background();
        other["layers"][0]["color"] = json!("#445566");
        let replaced = presets.save(Some(&first.id), "Uno", other.clone()).unwrap();
        assert_eq!(replaced.id, first.id);
        let list = presets.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, first.id);
        assert_eq!(list[0].name, "Uno");
        assert_eq!(list[0].background, other);
        assert_eq!(list[1], second);
        assert!(matches!(
            presets.save(Some("user-gone"), "X", background()),
            Err(PresetsError::Missing)
        ));
    }

    #[test]
    fn delete_removes_one_and_ignores_a_missing_id() {
        let dir = TempDir::new("delete");
        let presets = dir.presets();
        let first = presets.save(None, "One", background()).unwrap();
        let second = presets.save(None, "Two", background()).unwrap();
        presets.delete(&first.id).unwrap();
        presets.delete("user-gone").unwrap();
        assert_eq!(presets.list().unwrap(), vec![second]);
    }

    #[test]
    fn a_bad_name_or_background_is_refused() {
        let dir = TempDir::new("validation");
        let presets = dir.presets();
        let name_err = |name: &str| presets.save(None, name, background()).unwrap_err();
        assert!(matches!(name_err("   "), PresetsError::Name));
        assert!(matches!(name_err(&"a".repeat(41)), PresetsError::Name));
        assert!(matches!(name_err("two\nlines"), PresetsError::Name));
        assert!(presets.save(None, &"a".repeat(40), background()).is_ok());

        let bad = |value: serde_json::Value| presets.save(None, "Ok", value).unwrap_err();
        assert!(matches!(bad(json!([1])), PresetsError::Invalid(_)));
        assert!(matches!(
            bad(json!({ "version": 0, "layers": [{ "type": "solid" }] })),
            PresetsError::Invalid(_)
        ));
        assert!(matches!(
            bad(json!({ "version": 1, "layers": [] })),
            PresetsError::Invalid(_)
        ));
        assert!(matches!(
            bad(json!({ "version": 1, "layers": [{ "color": "#000000" }] })),
            PresetsError::Invalid(_)
        ));
        let many = vec![json!({ "type": "solid" }); MAX_LAYERS + 1];
        assert!(matches!(
            bad(json!({ "version": 1, "layers": many })),
            PresetsError::Invalid(_)
        ));
        let long = "x".repeat(MAX_BACKGROUND_BYTES);
        assert!(matches!(
            bad(json!({ "version": 1, "layers": [{ "type": "solid", "color": long }] })),
            PresetsError::TooLarge
        ));
    }

    #[test]
    fn the_201st_preset_is_refused() {
        let dir = TempDir::new("full");
        let presets = dir.presets();
        let one = UserPreset {
            id: "user-0".into(),
            name: "x".into(),
            background: background(),
        };
        let file = UserPresetsFile {
            version: CURRENT_VERSION,
            presets: (0..MAX_PRESETS)
                .map(|i| UserPreset {
                    id: format!("user-{i:x}"),
                    ..one.clone()
                })
                .collect(),
        };
        write(&dir.0.join(FILE_NAME), &file).unwrap();
        assert!(matches!(
            presets.save(None, "One more", background()),
            Err(PresetsError::Full)
        ));
        // Replacing an existing one still works when the list is full.
        assert!(
            presets
                .save(Some("user-0"), "Renamed", background())
                .is_ok()
        );
    }

    #[test]
    fn a_corrupt_file_is_backed_up_and_the_list_starts_empty() {
        let dir = TempDir::new("corrupt");
        let path = dir.0.join(FILE_NAME);
        fs::write(&path, "{ not json").unwrap();
        let presets = dir.presets();
        assert_eq!(presets.list().unwrap(), Vec::new());
        assert!(dir.0.join("presets.json.bak").exists());
        assert!(!path.exists());
        presets.save(None, "Fresh", background()).unwrap();
        assert_eq!(presets.list().unwrap().len(), 1);
    }

    #[test]
    fn two_corruptions_in_a_row_keep_both_backups() {
        let dir = TempDir::new("two-corrupt");
        let path = dir.0.join(FILE_NAME);
        fs::write(&path, "first").unwrap();
        assert_eq!(dir.presets().list().unwrap(), Vec::new());
        fs::write(&path, "second").unwrap();
        assert_eq!(dir.presets().list().unwrap(), Vec::new());
        assert_eq!(
            fs::read_to_string(dir.0.join("presets.json.bak")).unwrap(),
            "first"
        );
        assert_eq!(
            fs::read_to_string(dir.0.join("presets.json.bak.1")).unwrap(),
            "second"
        );
    }

    #[test]
    fn a_file_without_a_version_is_backed_up() {
        let dir = TempDir::new("unversioned");
        fs::write(dir.0.join(FILE_NAME), r#"{ "presets": [] }"#).unwrap();
        assert_eq!(dir.presets().list().unwrap(), Vec::new());
        assert!(dir.0.join("presets.json.bak").exists());
    }

    #[test]
    fn a_newer_file_is_never_overwritten() {
        let dir = TempDir::new("too-new");
        let path = dir.0.join(FILE_NAME);
        let text = r#"{ "version": 2, "presets": [{ "id": "a", "extra": true }] }"#;
        fs::write(&path, text).unwrap();
        let presets = dir.presets();
        assert!(matches!(presets.list(), Err(PresetsError::TooNew)));
        assert!(matches!(
            presets.save(None, "New", background()),
            Err(PresetsError::TooNew)
        ));
        assert!(matches!(presets.delete("a"), Err(PresetsError::TooNew)));
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        assert!(!dir.0.join("presets.json.bak").exists());
    }
}
