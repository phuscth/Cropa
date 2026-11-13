//! The images a user added to use as an editor background. Each one is a copy of
//! the file they picked, kept unchanged in a folder in the local data directory,
//! next to a versioned index. Every file on disk carries `version` where it is
//! JSON and goes through [`migrate`].
//!
//! The WebView decodes the picture and checks its dimensions before it sends it;
//! this module checks what it can without decoding (size, the format's magic
//! bytes, counts, ids) so a bad call cannot fill the disk or reach outside the
//! folder.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::presets::backup_path;

pub const CURRENT_VERSION: u32 = 1;
pub const INDEX_NAME: &str = "backgrounds.json";
pub const MAX_IMAGES: usize = 100;
pub const MAX_IMAGE_MB: u32 = 20;
pub const MAX_IMAGE_BYTES: usize = MAX_IMAGE_MB as usize * 1024 * 1024;
const MAX_NAME_CHARS: usize = 120;

/// What the WebView sees of a stored image: the id to ask for it by, and the name
/// of the file the user picked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImage {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    name: String,
    file: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFile {
    pub version: u32,
    images: Vec<Entry>,
}

impl Default for IndexFile {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            images: Vec::new(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MigrateError {
    #[error("images index has no numeric `version`")]
    MissingVersion,
    #[error("images index version {0} is newer than this build understands")]
    TooNew(u64),
    #[error("images index is malformed: {0}")]
    Malformed(#[from] serde_json::Error),
}

/// Bring any known on-disk version up to [`CURRENT_VERSION`]. Only version 1 exists.
pub fn migrate(value: serde_json::Value) -> Result<IndexFile, MigrateError> {
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
pub enum ImagesError {
    #[error("the file is not a PNG, JPEG or WebP picture")]
    NotSupported,
    #[error("the picture is larger than {MAX_IMAGE_MB} MB")]
    TooLarge,
    #[error("there are already {MAX_IMAGES} images")]
    Full,
    #[error("that image does not exist")]
    Missing,
    #[error("the images index was written by a newer version of Cropa")]
    TooNew,
    #[error("could not read the images: {0}")]
    Read(String),
    #[error("could not save the image: {0}")]
    Save(String),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Format {
    Png,
    Jpeg,
    Webp,
}

impl Format {
    /// The format named by the magic bytes at the start of `bytes`.
    fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
            Some(Self::Png)
        } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(Self::Jpeg)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else {
            None
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }

    fn from_extension(extension: &str) -> Option<Self> {
        match extension {
            "png" => Some(Self::Png),
            "jpg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
        }
    }
}

/// A stored image as the commands hand it out: the MIME type and the file bytes.
pub struct StoredImage {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// `img-` and 1 to 32 lowercase hex digits. The only ids that are turned into a path.
fn valid_id(id: &str) -> bool {
    id.strip_prefix("img-").is_some_and(|hex| {
        (1..=32).contains(&hex.len()) && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// The format of the file name `<id>.<ext>` an entry points at, or `None` when the
/// entry's `file` is not exactly that (a hand-edited index must not reach other files).
fn entry_format(entry: &Entry) -> Option<Format> {
    if !valid_id(&entry.id) {
        return None;
    }
    let extension = entry
        .file
        .strip_prefix(entry.id.as_str())?
        .strip_prefix('.')?;
    Format::from_extension(extension)
}

/// The index a damaged one is replaced with: every `img-<hex>.<ext>` file in the
/// folder, named after its file and in the order of the ids (which are times), so
/// pictures that lost their index are not stranded where nothing can list or delete them.
fn rebuild(dir: &Path) -> IndexFile {
    let mut found: Vec<(u128, Entry)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|item| {
            let file = item.file_name().into_string().ok()?;
            let (id, extension) = file.rsplit_once('.')?;
            Format::from_extension(extension)?;
            if !valid_id(id) {
                return None;
            }
            let order = u128::from_str_radix(id.strip_prefix("img-")?, 16).ok()?;
            let entry = Entry {
                id: id.to_owned(),
                name: clean_name(&file),
                file: file.clone(),
            };
            item.file_type().ok()?.is_file().then_some((order, entry))
        })
        .collect();
    found.sort_by_key(|(order, _)| *order);
    IndexFile {
        version: CURRENT_VERSION,
        images: found
            .into_iter()
            .map(|(_, entry)| entry)
            .take(MAX_IMAGES)
            .collect(),
    }
}

/// Load the index at `path`. A missing file is an empty list. A file that is
/// malformed or has no version is moved aside to `<name>.bak` and replaced by an
/// index rebuilt from the picture files beside it, so a bad file never blocks adding
/// images or hides the ones already stored. A file from a newer build is an error
/// and stays where it is.
fn load(path: &Path) -> Result<IndexFile, ImagesError> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(IndexFile::default()),
        Err(err) => return Err(ImagesError::Read(err.to_string())),
    };
    let parsed = serde_json::from_slice(&raw)
        .map_err(MigrateError::from)
        .and_then(migrate);
    match parsed {
        Ok(file) => Ok(file),
        Err(MigrateError::TooNew(_)) => Err(ImagesError::TooNew),
        Err(err) => {
            log::warn!("background images index reset to an empty list: {err}");
            // If the file cannot be set aside, stop: the next save would replace it.
            fs::rename(path, backup_path(path)).map_err(|err| {
                ImagesError::Read(format!("could not back up the old file: {err}"))
            })?;
            let rebuilt = rebuild(path.parent().unwrap_or_else(|| Path::new("")));
            if !rebuilt.images.is_empty() {
                write_index(path, &rebuilt)?;
            }
            Ok(rebuilt)
        }
    }
}

/// Write `bytes` atomically: a temp file next to the target, then rename.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut out = fs::File::create(&tmp)?;
    out.write_all(bytes)?;
    out.sync_all()?;
    drop(out);
    fs::rename(&tmp, path)
}

fn write_index(path: &Path, file: &IndexFile) -> Result<(), ImagesError> {
    let json = serde_json::to_vec_pretty(file).map_err(|err| ImagesError::Save(err.to_string()))?;
    write_atomic(path, &json).map_err(|err| ImagesError::Save(err.to_string()))
}

/// The name as stored: trimmed, no control characters, at most 120 characters.
fn clean_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "image".to_owned()
    } else {
        cleaned.to_owned()
    }
}

/// `img-<hex of nanoseconds since the epoch>`, bumped until no image has it.
fn new_id(existing: &[Entry]) -> String {
    let mut nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    loop {
        let id = format!("img-{nanos:x}");
        if !existing.iter().any(|e| e.id == id) {
            return id;
        }
        nanos += 1;
    }
}

/// The user's background images on disk. One lock covers each read-modify-write.
pub struct BackgroundImages {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl BackgroundImages {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
        }
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join(INDEX_NAME)
    }

    /// The images in the order they were added. An entry whose file is gone is left out.
    pub fn list(&self) -> Result<Vec<BackgroundImage>, ImagesError> {
        let _guard = self.guard();
        let file = load(&self.index_path())?;
        Ok(file
            .images
            .into_iter()
            .filter(|entry| entry_format(entry).is_some() && self.dir.join(&entry.file).is_file())
            .map(|entry| BackgroundImage {
                id: entry.id,
                name: entry.name,
            })
            .collect())
    }

    /// Stores the picture in `data` (base64 of the file's bytes) and lists it.
    pub fn add(&self, name: &str, data: &str) -> Result<BackgroundImage, ImagesError> {
        // Four base64 characters carry three bytes; refuse before decoding a huge string.
        if data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err(ImagesError::TooLarge);
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| ImagesError::NotSupported)?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(ImagesError::TooLarge);
        }
        let format = Format::sniff(&bytes).ok_or(ImagesError::NotSupported)?;
        let _guard = self.guard();
        let mut index = load(&self.index_path())?;
        if index.images.len() >= MAX_IMAGES {
            return Err(ImagesError::Full);
        }
        let id = new_id(&index.images);
        let file = format!("{id}.{}", format.extension());
        let path = self.dir.join(&file);
        write_atomic(&path, &bytes).map_err(|err| ImagesError::Save(err.to_string()))?;
        let image = BackgroundImage {
            id: id.clone(),
            name: clean_name(name),
        };
        index.images.push(Entry {
            id,
            name: image.name.clone(),
            file,
        });
        if let Err(err) = write_index(&self.index_path(), &index) {
            // The file has no index entry, so nothing would ever delete it.
            let _ = fs::remove_file(&path);
            return Err(err);
        }
        Ok(image)
    }

    /// The stored file. An id that is not well formed, is not in the index or has lost its file is missing.
    pub fn read(&self, id: &str) -> Result<StoredImage, ImagesError> {
        if !valid_id(id) {
            return Err(ImagesError::Missing);
        }
        let _guard = self.guard();
        let file = load(&self.index_path())?;
        let entry = file
            .images
            .iter()
            .find(|entry| entry.id == id)
            .ok_or(ImagesError::Missing)?;
        let format = entry_format(entry).ok_or(ImagesError::Missing)?;
        match fs::read(self.dir.join(&entry.file)) {
            Ok(bytes) => Ok(StoredImage {
                mime: format.mime(),
                bytes,
            }),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Err(ImagesError::Missing),
            Err(err) => Err(ImagesError::Read(err.to_string())),
        }
    }

    /// Removes the image and its file. An image that is not there is not an error;
    /// an id that is not well formed is refused.
    pub fn delete(&self, id: &str) -> Result<(), ImagesError> {
        if !valid_id(id) {
            return Err(ImagesError::Missing);
        }
        let _guard = self.guard();
        let mut file = load(&self.index_path())?;
        let Some(at) = file.images.iter().position(|entry| entry.id == id) else {
            return Ok(());
        };
        let entry = file.images.remove(at);
        write_index(&self.index_path(), &file)?;
        if entry_format(&entry).is_some() {
            match fs::remove_file(self.dir.join(&entry.file)) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => log::warn!("could not remove a background image file: {err}"),
            }
        }
        Ok(())
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
                "cropa-backgrounds-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn images(&self) -> BackgroundImages {
            BackgroundImages::new(self.0.join("backgrounds"))
        }

        fn index(&self) -> PathBuf {
            self.0.join("backgrounds").join(INDEX_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn encode(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn png() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(b"pixels");
        bytes
    }

    fn jpeg() -> Vec<u8> {
        vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]
    }

    fn webp() -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[10, 0, 0, 0]);
        bytes.extend_from_slice(b"WEBPVP8 ");
        bytes
    }

    #[test]
    fn migrate_reads_version_1_and_rejects_the_rest() {
        let file = json!({ "version": 1, "images": [] });
        assert_eq!(migrate(file).unwrap(), IndexFile::default());
        assert!(matches!(
            migrate(json!({ "images": [] })),
            Err(MigrateError::MissingVersion)
        ));
        assert!(matches!(
            migrate(json!({ "version": 2, "images": [] })),
            Err(MigrateError::TooNew(2))
        ));
        assert!(matches!(
            migrate(json!({ "version": 1, "images": "no" })),
            Err(MigrateError::Malformed(_))
        ));
    }

    #[test]
    fn add_then_list_and_read_round_trip_through_the_files() {
        let dir = TempDir::new("roundtrip");
        let images = dir.images();
        let first = images.add("  sky\u{0007}.png  ", &encode(&png())).unwrap();
        let second = images.add("photo.jpg", &encode(&jpeg())).unwrap();
        assert!(first.id.starts_with("img-"));
        assert_eq!(first.name, "sky.png");
        // A fresh handle reads what the first one wrote, in the order added.
        let fresh = dir.images();
        assert_eq!(fresh.list().unwrap(), vec![first.clone(), second.clone()]);
        let stored = fresh.read(&first.id).unwrap();
        assert_eq!((stored.mime, stored.bytes), ("image/png", png()));
        let stored = fresh.read(&second.id).unwrap();
        assert_eq!((stored.mime, stored.bytes), ("image/jpeg", jpeg()));
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.index()).unwrap()).unwrap();
        assert_eq!(on_disk["version"], 1);
        assert_eq!(on_disk["images"][0]["file"], format!("{}.png", first.id));
    }

    #[test]
    fn only_png_jpeg_and_webp_are_accepted() {
        let dir = TempDir::new("sniff");
        let images = dir.images();
        for bytes in [png(), jpeg(), webp()] {
            assert!(images.add("ok", &encode(&bytes)).is_ok());
        }
        let refused = |bytes: &[u8]| images.add("no", &encode(bytes)).unwrap_err();
        assert!(matches!(refused(b"GIF89a....."), ImagesError::NotSupported));
        assert!(matches!(refused(b"just text"), ImagesError::NotSupported));
        assert!(matches!(
            refused(b"RIFF\0\0\0\0WAVEfmt "),
            ImagesError::NotSupported
        ));
        assert!(matches!(refused(b""), ImagesError::NotSupported));
        assert!(matches!(
            images.add("no", "***not base64***").unwrap_err(),
            ImagesError::NotSupported
        ));
        assert_eq!(images.list().unwrap().len(), 3);
    }

    #[test]
    fn a_picture_over_the_size_limit_is_refused() {
        let dir = TempDir::new("size");
        let images = dir.images();
        let mut big = png();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(matches!(
            images.add("big", &encode(&big)).unwrap_err(),
            ImagesError::TooLarge
        ));
        big.truncate(MAX_IMAGE_BYTES);
        assert!(images.add("just fits", &encode(&big)).is_ok());
        assert_eq!(images.list().unwrap().len(), 1);
    }

    #[test]
    fn the_101st_image_is_refused() {
        let dir = TempDir::new("full");
        let images = dir.images();
        let entries: Vec<Entry> = (0..MAX_IMAGES)
            .map(|i| Entry {
                id: format!("img-{i:x}"),
                name: "x".into(),
                file: format!("img-{i:x}.png"),
            })
            .collect();
        let index = IndexFile {
            version: CURRENT_VERSION,
            images: entries,
        };
        write_index(&dir.index(), &index).unwrap();
        assert!(matches!(
            images.add("one more", &encode(&png())).unwrap_err(),
            ImagesError::Full
        ));
    }

    #[test]
    fn delete_removes_the_file_and_the_entry_and_ignores_a_missing_id() {
        let dir = TempDir::new("delete");
        let images = dir.images();
        let first = images.add("one", &encode(&png())).unwrap();
        let second = images.add("two", &encode(&webp())).unwrap();
        let file = dir.0.join("backgrounds").join(format!("{}.png", first.id));
        assert!(file.exists());
        images.delete(&first.id).unwrap();
        images.delete("img-abc123").unwrap();
        assert!(!file.exists());
        assert_eq!(images.list().unwrap(), vec![second]);
        assert!(matches!(images.read(&first.id), Err(ImagesError::Missing)));
    }

    #[test]
    fn an_id_that_could_leave_the_folder_is_refused_before_any_io() {
        let dir = TempDir::new("traversal");
        let images = dir.images();
        // Nothing exists yet: a refusal here cannot have come from reading the index.
        for id in [
            "..",
            "../x",
            "img-../x",
            "img-a/b",
            "img-a\\b",
            "img-",
            "IMG-1",
            "img-G",
            "img-1.png",
        ] {
            assert!(matches!(images.read(id), Err(ImagesError::Missing)), "{id}");
            assert!(
                matches!(images.delete(id), Err(ImagesError::Missing)),
                "{id}"
            );
        }
        assert!(!dir.0.join("backgrounds").exists());
        let too_long = format!("img-{}", "a".repeat(33));
        assert!(matches!(images.read(&too_long), Err(ImagesError::Missing)));
    }

    #[test]
    fn an_index_entry_that_points_elsewhere_is_never_followed() {
        let dir = TempDir::new("forged");
        let secret = dir.0.join("secret.png");
        fs::write(&secret, png()).unwrap();
        let index = IndexFile {
            version: CURRENT_VERSION,
            images: vec![Entry {
                id: "img-1".into(),
                name: "forged".into(),
                file: "../secret.png".into(),
            }],
        };
        write_index(&dir.index(), &index).unwrap();
        let images = dir.images();
        assert_eq!(images.list().unwrap(), Vec::new());
        assert!(matches!(images.read("img-1"), Err(ImagesError::Missing)));
        images.delete("img-1").unwrap();
        assert!(secret.exists());
    }

    #[test]
    fn an_entry_whose_file_is_gone_is_dropped_from_the_list() {
        let dir = TempDir::new("gone");
        let images = dir.images();
        let kept = images.add("kept", &encode(&png())).unwrap();
        let lost = images.add("lost", &encode(&jpeg())).unwrap();
        fs::remove_file(dir.0.join("backgrounds").join(format!("{}.jpg", lost.id))).unwrap();
        assert_eq!(images.list().unwrap(), vec![kept]);
        assert!(matches!(images.read(&lost.id), Err(ImagesError::Missing)));
    }

    #[test]
    fn a_corrupt_index_is_backed_up_and_the_list_starts_empty() {
        let dir = TempDir::new("corrupt");
        fs::create_dir_all(dir.0.join("backgrounds")).unwrap();
        fs::write(dir.index(), "{ not json").unwrap();
        let images = dir.images();
        assert_eq!(images.list().unwrap(), Vec::new());
        assert!(
            dir.0
                .join("backgrounds")
                .join("backgrounds.json.bak")
                .exists()
        );
        assert!(!dir.index().exists());
        images.add("fresh", &encode(&png())).unwrap();
        assert_eq!(images.list().unwrap().len(), 1);
    }

    #[test]
    fn a_corrupt_index_is_rebuilt_from_the_picture_files() {
        let dir = TempDir::new("rebuild");
        let folder = dir.0.join("backgrounds");
        fs::create_dir_all(&folder).unwrap();
        // Ids sort by value, not as text: 2 comes before 10.
        for file in ["img-10.jpg", "img-2.png", "img-3.webp"] {
            fs::write(folder.join(file), b"x").unwrap();
        }
        // Files that are not pictures of this store are left out.
        for file in [
            "notes.txt",
            "img-zz.png",
            "img-4.gif",
            "other.png",
            "img-5.png.tmp",
        ] {
            fs::write(folder.join(file), b"x").unwrap();
        }
        fs::write(dir.index(), "{ not json").unwrap();
        let images = dir.images();
        let listed = images.list().unwrap();
        let ids: Vec<&str> = listed.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["img-2", "img-3", "img-10"]);
        assert_eq!(listed[0].name, "img-2.png");
        assert!(folder.join("backgrounds.json.bak").exists());
        // The rebuilt index is on disk, so the pictures can be read and deleted.
        assert!(dir.index().exists());
        assert_eq!(images.read("img-3").unwrap().mime, "image/webp");
        images.delete("img-2").unwrap();
        assert!(!folder.join("img-2.png").exists());
        assert_eq!(dir.images().list().unwrap().len(), 2);
    }

    #[test]
    fn a_newer_index_is_never_overwritten() {
        let dir = TempDir::new("too-new");
        fs::create_dir_all(dir.0.join("backgrounds")).unwrap();
        let text = r#"{ "version": 2, "images": [{ "id": "a", "extra": true }] }"#;
        fs::write(dir.index(), text).unwrap();
        let images = dir.images();
        assert!(matches!(images.list(), Err(ImagesError::TooNew)));
        assert!(matches!(
            images.add("new", &encode(&png())),
            Err(ImagesError::TooNew)
        ));
        assert!(matches!(images.delete("img-a"), Err(ImagesError::TooNew)));
        assert!(matches!(images.read("img-a"), Err(ImagesError::TooNew)));
        assert_eq!(fs::read_to_string(dir.index()).unwrap(), text);
        assert!(
            !dir.0
                .join("backgrounds")
                .join("backgrounds.json.bak")
                .exists()
        );
    }
}
