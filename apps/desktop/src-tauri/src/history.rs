//! Capture history: the last few captures, kept as PNG files in one folder.
//!
//! `<dir>/<id>.png` is the original capture and `<dir>/thumbnails/<id>.png` a
//! small copy for the grid. An id is the capture time in milliseconds since the
//! Unix epoch, written as decimal digits. There is no index file: everything is
//! derived from the file names, so nothing custom is written to disk and there
//! is nothing to migrate.
//!
//! A capture's AI chat is `<dir>/chats/<id>.json` (see [`crate::chat`]); it goes
//! when its capture goes.
//!
//! The WebView never passes a path. It passes an id, which [`History`] checks
//! (ASCII digits only, 1 to 20 of them) before building a path inside its own
//! folder.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, RgbaImage};
use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

use crate::chat::{self, ChatError, ChatMessage, MigrateError};

/// How many captures are kept.
pub const KEEP: usize = 50;
/// How long a capture is kept.
pub const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// A thumbnail fits inside this many pixels and is never enlarged.
pub const THUMBNAIL_MAX: (u32, u32) = (480, 320);

const THUMBNAILS: &str = "thumbnails";
const CHATS: &str = "chats";
const MAX_ID_LEN: usize = 20;

/// The history changed: a capture was saved or deleted.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct HistoryChanged;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub captured_at: f64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("that capture is not in the history")]
    Missing,
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Image(String),
}

pub struct History {
    dir: PathBuf,
    /// Serialises every write, delete and prune.
    lock: Mutex<()>,
}

impl History {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
        }
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn thumbnails_dir(&self) -> PathBuf {
        self.dir.join(THUMBNAILS)
    }

    fn chats_dir(&self) -> PathBuf {
        self.dir.join(CHATS)
    }

    fn chat_path(&self, id: &str) -> PathBuf {
        self.chats_dir().join(format!("{id}.json"))
    }

    /// The conversation of a capture. A missing file, or one with no usable version or
    /// shape, is an empty conversation: the next save replaces it.
    pub fn chat(&self, id: &str) -> Result<Vec<ChatMessage>, ChatError> {
        let id = valid_id(id).map_err(|_| ChatError::Invalid("historyId"))?;
        let _guard = self.guard();
        let raw = match fs::read(self.chat_path(id)) {
            Ok(raw) => raw,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(ChatError::Read(err.to_string())),
        };
        let parsed = serde_json::from_slice(&raw)
            .map_err(MigrateError::from)
            .and_then(chat::migrate);
        match parsed {
            Ok(file) => Ok(file.messages),
            Err(MigrateError::TooNew(_)) => Err(ChatError::TooNew),
            Err(err) => {
                // The error text can quote the file, so only its kind is logged.
                log::warn!(
                    "chat of capture {id} reset to an empty conversation: {}",
                    err.kind()
                );
                Ok(Vec::new())
            }
        }
    }

    /// Replace the conversation of a capture, dropping the oldest messages over the caps.
    /// Returns `false`, writing nothing, when the capture is not in the history.
    pub fn save_chat(&self, id: &str, messages: Vec<ChatMessage>) -> Result<bool, ChatError> {
        let id = valid_id(id).map_err(|_| ChatError::Invalid("historyId"))?;
        for message in &messages {
            chat::validate(message)?;
        }
        let bytes = chat::encode_capped(messages)?;
        let _guard = self.guard();
        if !self.dir.join(format!("{id}.png")).exists() {
            return Ok(false);
        }
        let save_error = |err: io::Error| ChatError::Save(err.to_string());
        fs::create_dir_all(self.chats_dir()).map_err(save_error)?;
        let path = self.chat_path(id);
        let tmp = self.chats_dir().join(format!("{id}.json.tmp"));
        fs::write(&tmp, bytes).map_err(save_error)?;
        fs::rename(&tmp, &path).map_err(save_error)?;
        Ok(true)
    }

    /// Store a capture and its thumbnail, then drop what is over the limits.
    /// Returns the new id.
    pub fn save(&self, image: &RgbaImage, at: SystemTime) -> Result<String, HistoryError> {
        let _guard = self.guard();
        fs::create_dir_all(self.thumbnails_dir())?;

        let mut millis = unix_millis(at);
        let id = loop {
            let id = millis.to_string();
            if !self.dir.join(format!("{id}.png")).exists() {
                break id;
            }
            millis += 1;
        };

        write_png(&self.dir.join(format!("{id}.png")), image)?;
        write_png(
            &self.thumbnails_dir().join(format!("{id}.png")),
            &thumbnail(image),
        )?;
        self.prune_locked(at);
        Ok(id)
    }

    /// The captures, newest first. Files that are not history entries are ignored.
    pub fn list(&self, now: SystemTime) -> Vec<HistoryItem> {
        let _guard = self.guard();
        self.prune_locked(now);
        let mut items = Vec::new();
        for (millis, id) in self.ids() {
            let path = self.dir.join(format!("{id}.png"));
            match image::image_dimensions(&path) {
                Ok((width, height)) => items.push(HistoryItem {
                    id,
                    #[allow(clippy::cast_precision_loss)]
                    captured_at: millis as f64,
                    width,
                    height,
                }),
                Err(err) => log::warn!("skipping history entry {id}: {err}"),
            }
        }
        items
    }

    /// When the capture was taken, in milliseconds since the Unix epoch: its id.
    pub fn captured_at(id: &str) -> Result<f64, HistoryError> {
        let id = valid_id(id)?;
        #[allow(clippy::cast_precision_loss)]
        id.parse::<u128>()
            .map(|millis| millis as f64)
            .map_err(|_| HistoryError::Missing)
    }

    /// The PNG bytes of the original capture.
    pub fn original(&self, id: &str) -> Result<Vec<u8>, HistoryError> {
        let id = valid_id(id)?;
        read(&self.dir.join(format!("{id}.png")))
    }

    /// The PNG bytes of the thumbnail, or of the original when the thumbnail is gone.
    pub fn thumbnail(&self, id: &str) -> Result<Vec<u8>, HistoryError> {
        let id = valid_id(id)?;
        match fs::read(self.thumbnails_dir().join(format!("{id}.png"))) {
            Ok(bytes) => Ok(bytes),
            Err(err) if err.kind() == io::ErrorKind::NotFound => self.original(id),
            Err(err) => Err(err.into()),
        }
    }

    /// Remove one capture, its thumbnail and its chat.
    pub fn delete(&self, id: &str) -> Result<(), HistoryError> {
        let id = valid_id(id)?;
        let _guard = self.guard();
        // The conversation goes last: if the capture cannot be removed, it stays with its chat.
        let original = remove(&self.dir.join(format!("{id}.png")));
        if matches!(original, Err(HistoryError::Io(_))) {
            return original;
        }
        remove_if_present(&self.thumbnails_dir().join(format!("{id}.png")))?;
        remove_if_present(&self.chat_path(id))?;
        original
    }

    /// Remove every capture, thumbnail and chat. Other files in the folder stay.
    pub fn delete_all(&self) -> Result<(), HistoryError> {
        let _guard = self.guard();
        for dir in [self.dir.clone(), self.thumbnails_dir()] {
            for (_, id) in ids_in(&dir) {
                remove_if_present(&dir.join(format!("{id}.png")))?;
            }
            for name in leftovers_in(&dir) {
                remove_if_present(&dir.join(name))?;
            }
        }
        // Conversations last, so a capture that could not be removed keeps its chat.
        let chats = self.chats_dir();
        for (_, id) in ids_with_suffix(&chats, ".json") {
            remove_if_present(&chats.join(format!("{id}.json")))?;
        }
        for (_, id) in ids_with_suffix(&chats, ".json.tmp") {
            remove_if_present(&chats.join(format!("{id}.json.tmp")))?;
        }
        Ok(())
    }

    /// Keep the [`KEEP`] newest captures that are no older than [`MAX_AGE`], and
    /// drop thumbnails and chats whose original is gone.
    pub fn prune(&self, now: SystemTime) {
        let _guard = self.guard();
        self.prune_locked(now);
    }

    fn prune_locked(&self, now: SystemTime) {
        let now_millis = unix_millis(now);
        let max_age = MAX_AGE.as_millis();
        let mut kept = 0;
        for (millis, id) in self.ids() {
            let too_old = now_millis.saturating_sub(millis) > max_age;
            if too_old || kept >= KEEP {
                let original = self.dir.join(format!("{id}.png"));
                let thumbnail = self.thumbnails_dir().join(format!("{id}.png"));
                for path in [original, thumbnail, self.chat_path(&id)] {
                    if let Err(err) = remove_if_present(&path) {
                        log::warn!("could not remove history entry {id}: {err}");
                    }
                }
            } else {
                kept += 1;
            }
        }
        for dir in [self.dir.clone(), self.thumbnails_dir()] {
            for name in leftovers_in(&dir) {
                if let Err(err) = remove_if_present(&dir.join(&name)) {
                    log::warn!("could not remove {name}: {err}");
                }
            }
        }
        let chats = self.chats_dir();
        for (_, id) in ids_with_suffix(&chats, ".json") {
            if !self.dir.join(format!("{id}.png")).exists()
                && let Err(err) = remove_if_present(&chats.join(format!("{id}.json")))
            {
                log::warn!("could not remove the chat of capture {id}: {err}");
            }
        }
        for (_, id) in ids_with_suffix(&chats, ".json.tmp") {
            if let Err(err) = remove_if_present(&chats.join(format!("{id}.json.tmp"))) {
                log::warn!("could not remove a chat leftover {id}: {err}");
            }
        }
        for (_, id) in ids_in(&self.thumbnails_dir()) {
            if !self.dir.join(format!("{id}.png")).exists()
                && let Err(err) =
                    remove_if_present(&self.thumbnails_dir().join(format!("{id}.png")))
            {
                log::warn!("could not remove history thumbnail {id}: {err}");
            }
        }
    }

    /// Ids of the originals, newest first, as `(milliseconds, id)`.
    fn ids(&self) -> Vec<(u128, String)> {
        ids_in(&self.dir)
    }
}

/// Milliseconds since the Unix epoch, as the editor and the WebView count them.
#[allow(clippy::cast_precision_loss)]
pub fn epoch_millis(at: SystemTime) -> f64 {
    unix_millis(at) as f64
}

/// The id a capture taken at `at` gets, unless another capture took the same millisecond.
pub fn history_id_at(at: SystemTime) -> String {
    unix_millis(at).to_string()
}

fn unix_millis(at: SystemTime) -> u128 {
    at.duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

/// An id is 1 to 20 ASCII digits; anything else cannot name a history file.
fn valid_id(id: &str) -> Result<&str, HistoryError> {
    if (1..=MAX_ID_LEN).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit()) {
        Ok(id)
    } else {
        Err(HistoryError::Missing)
    }
}

/// Every `<digits>.png` directly in `dir`, newest first. A missing folder is empty.
fn ids_in(dir: &Path) -> Vec<(u128, String)> {
    ids_with_suffix(dir, ".png")
}

/// Every `<digits>.png.tmp` directly in `dir`: a write that never reached its
/// rename, for instance after a crash.
fn leftovers_in(dir: &Path) -> Vec<String> {
    ids_with_suffix(dir, ".png.tmp")
        .into_iter()
        .map(|(_, id)| format!("{id}.png.tmp"))
        .collect()
}

fn ids_with_suffix(dir: &Path, suffix: &str) -> Vec<(u128, String)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(u128, String)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_suffix(suffix)?;
            let id = valid_id(id).ok()?;
            Some((id.parse::<u128>().ok()?, id.to_owned()))
        })
        .collect();
    found.sort_by(|a, b| b.cmp(a));
    found
}

fn read(path: &Path) -> Result<Vec<u8>, HistoryError> {
    fs::read(path).map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            HistoryError::Missing
        } else {
            err.into()
        }
    })
}

fn remove(path: &Path) -> Result<(), HistoryError> {
    fs::remove_file(path).map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            HistoryError::Missing
        } else {
            err.into()
        }
    })
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

/// The image scaled to fit [`THUMBNAIL_MAX`], never enlarged.
fn thumbnail(image: &RgbaImage) -> RgbaImage {
    let (max_width, max_height) = THUMBNAIL_MAX;
    if image.width() <= max_width && image.height() <= max_height {
        return image.clone();
    }
    let scale = (f64::from(max_width) / f64::from(image.width()))
        .min(f64::from(max_height) / f64::from(image.height()));
    let fit = |side: u32| {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let scaled = (f64::from(side) * scale).round() as u32;
        scaled.max(1)
    };
    image::imageops::thumbnail(image, fit(image.width()), fit(image.height()))
}

/// Write a PNG next to its final name, then rename it, so a crash never leaves
/// a half-written `<id>.png`.
fn write_png(path: &Path, image: &RgbaImage) -> Result<(), HistoryError> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|err| HistoryError::Image(err.to_string()))?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use image::Rgba;

    use super::*;
    use crate::chat;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "cropa-history-{tag}-{}-{:?}",
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

    fn tiny() -> RgbaImage {
        RgbaImage::from_pixel(2, 2, Rgba([10, 20, 30, 255]))
    }

    fn millis(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    fn history(dir: &TempDir) -> History {
        History::new(dir.0.join("history"))
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().is_file())
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn only_the_newest_fifty_are_kept() {
        let dir = TempDir::new("keep");
        let history = history(&dir);
        let base = SystemTime::now();
        let ids: Vec<String> = (0..55)
            .map(|i| history.save(&tiny(), base + millis(i)).unwrap())
            .collect();

        let listed = history.list(base + millis(60));
        assert_eq!(listed.len(), KEEP);
        let listed_ids: Vec<&str> = listed.iter().map(|item| item.id.as_str()).collect();
        let newest: Vec<&str> = ids.iter().rev().take(KEEP).map(String::as_str).collect();
        assert_eq!(listed_ids, newest);

        let thumbnails = files(&history.thumbnails_dir());
        assert_eq!(thumbnails.len(), KEEP);
        for old in &ids[..5] {
            assert!(!thumbnails.contains(&format!("{old}.png")));
            assert!(matches!(history.original(old), Err(HistoryError::Missing)));
        }
    }

    #[test]
    fn an_entry_reports_when_it_was_captured() {
        let dir = TempDir::new("captured-at");
        let history = history(&dir);
        let at = UNIX_EPOCH + millis(1_700_000_000_123);
        let id = history.save(&tiny(), at).unwrap();
        assert_eq!(History::captured_at(&id).unwrap(), 1_700_000_000_123.0);
        assert!(History::captured_at("../x").is_err());
    }

    #[test]
    fn captures_older_than_thirty_days_are_deleted() {
        let dir = TempDir::new("age");
        let history = history(&dir);
        let now = SystemTime::now();
        let day = Duration::from_secs(24 * 60 * 60);
        let old = history.save(&tiny(), now - day * 31).unwrap();
        let edge = history.save(&tiny(), now - day * 30).unwrap();
        let recent = history.save(&tiny(), now - day * 29).unwrap();

        let ids: Vec<String> = history.list(now).into_iter().map(|item| item.id).collect();

        assert_eq!(ids, [recent, edge]);
        assert!(!history.dir.join(format!("{old}.png")).exists());
        assert!(!history.thumbnails_dir().join(format!("{old}.png")).exists());
    }

    #[test]
    fn two_saves_in_one_millisecond_get_distinct_ids() {
        let dir = TempDir::new("same-ms");
        let history = history(&dir);
        let at = SystemTime::now();
        let first = history.save(&tiny(), at).unwrap();
        let second = history.save(&tiny(), at).unwrap();
        assert_ne!(first, second);
        assert_eq!(history.list(at).len(), 2);
    }

    #[test]
    fn a_bad_id_is_missing_and_touches_nothing() {
        let dir = TempDir::new("ids");
        let history = history(&dir);
        history.save(&tiny(), SystemTime::now()).unwrap();
        fs::write(dir.0.join("settings.json"), "keep me").unwrap();
        let before = files(&history.dir);

        let too_long = "1".repeat(21);
        for id in [
            "",
            "../settings",
            "..\\x",
            "C:\\x",
            "1.png",
            "12a",
            too_long.as_str(),
        ] {
            assert!(
                matches!(history.original(id), Err(HistoryError::Missing)),
                "{id}"
            );
            assert!(
                matches!(history.thumbnail(id), Err(HistoryError::Missing)),
                "{id}"
            );
            assert!(
                matches!(history.delete(id), Err(HistoryError::Missing)),
                "{id}"
            );
        }
        assert_eq!(files(&history.dir), before);
        assert!(dir.0.join("settings.json").exists());
    }

    #[test]
    fn list_is_newest_first_with_sizes_and_ignores_foreign_files() {
        let dir = TempDir::new("list");
        let history = history(&dir);
        let base = SystemTime::now();
        let older = history.save(&RgbaImage::new(3, 2), base).unwrap();
        let newer = history
            .save(&RgbaImage::new(5, 4), base + millis(10))
            .unwrap();
        fs::write(history.dir.join("notes.txt"), "x").unwrap();
        fs::write(history.dir.join("123.png.tmp"), "x").unwrap();

        let listed = history.list(base + millis(20));

        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, newer);
        assert_eq!((listed[0].width, listed[0].height), (5, 4));
        assert_eq!(listed[1].id, older);
        assert_eq!((listed[1].width, listed[1].height), (3, 2));
        assert!(history.dir.join("notes.txt").exists());
    }

    #[test]
    fn delete_removes_both_files_and_a_second_delete_is_missing() {
        let dir = TempDir::new("delete");
        let history = history(&dir);
        let id = history.save(&tiny(), SystemTime::now()).unwrap();

        history.delete(&id).unwrap();

        assert!(!history.dir.join(format!("{id}.png")).exists());
        assert!(!history.thumbnails_dir().join(format!("{id}.png")).exists());
        assert!(matches!(history.delete(&id), Err(HistoryError::Missing)));
    }

    #[test]
    fn leftover_temp_files_are_pruned_and_deleted_but_foreign_ones_stay() {
        let dir = TempDir::new("leftovers");
        let history = history(&dir);
        let now = SystemTime::now();
        history.save(&tiny(), now).unwrap();
        let stray = |folder: &Path| {
            fs::write(folder.join("111.png.tmp"), "x").unwrap();
            fs::write(folder.join("keep.png.tmp"), "x").unwrap();
        };
        stray(&history.dir);
        stray(&history.thumbnails_dir());

        history.prune(now);
        for folder in [history.dir.clone(), history.thumbnails_dir()] {
            assert!(!folder.join("111.png.tmp").exists());
            assert!(folder.join("keep.png.tmp").exists());
        }

        stray(&history.dir);
        stray(&history.thumbnails_dir());
        history.delete_all().unwrap();
        for folder in [history.dir.clone(), history.thumbnails_dir()] {
            assert!(!folder.join("111.png.tmp").exists());
            assert!(folder.join("keep.png.tmp").exists());
        }
    }

    #[test]
    fn delete_all_keeps_foreign_files() {
        let dir = TempDir::new("delete-all");
        let history = history(&dir);
        let base = SystemTime::now();
        history.save(&tiny(), base).unwrap();
        history.save(&tiny(), base + millis(1)).unwrap();
        fs::write(history.dir.join("notes.txt"), "x").unwrap();

        history.delete_all().unwrap();

        assert_eq!(files(&history.dir), ["notes.txt"]);
        assert_eq!(files(&history.thumbnails_dir()).len(), 0);
    }

    #[test]
    fn a_thumbnail_fits_the_limit_and_keeps_the_aspect_ratio() {
        let wide = thumbnail(&RgbaImage::new(1920, 1080));
        assert_eq!((wide.width(), wide.height()), (480, 270));

        let tall = thumbnail(&RgbaImage::new(400, 1600));
        assert_eq!((tall.width(), tall.height()), (80, 320));

        let small = thumbnail(&RgbaImage::new(100, 50));
        assert_eq!((small.width(), small.height()), (100, 50));

        let sliver = thumbnail(&RgbaImage::new(5000, 2));
        assert_eq!((sliver.width(), sliver.height()), (480, 1));
    }

    #[test]
    fn the_stored_thumbnail_is_smaller_than_the_original() {
        let dir = TempDir::new("thumb-file");
        let history = history(&dir);
        let id = history
            .save(&RgbaImage::new(960, 640), SystemTime::now())
            .unwrap();
        let bytes = history.thumbnail(&id).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (480, 320));
    }

    fn convo() -> Vec<ChatMessage> {
        vec![
            chat::tests::user("u1", "make it blue"),
            chat::tests::agent("a1", "Done"),
        ]
    }

    fn chat_files(history: &History) -> Vec<String> {
        files(&history.chats_dir())
    }

    #[test]
    fn a_conversation_survives_a_restart() {
        let dir = TempDir::new("chat-restart");
        let id = history(&dir).save(&tiny(), SystemTime::now()).unwrap();
        assert!(history(&dir).save_chat(&id, convo()).unwrap());

        let reopened = history(&dir);
        assert_eq!(reopened.chat(&id).unwrap(), convo());
        assert_eq!(chat_files(&reopened), [format!("{id}.json")]);
    }

    #[test]
    fn a_missing_file_or_one_without_a_version_is_an_empty_conversation() {
        let dir = TempDir::new("chat-empty");
        let history = history(&dir);
        let id = history.save(&tiny(), SystemTime::now()).unwrap();
        assert_eq!(history.chat(&id).unwrap(), Vec::<ChatMessage>::new());

        fs::create_dir_all(history.chats_dir()).unwrap();
        fs::write(history.chat_path(&id), r#"{"messages":[]}"#).unwrap();
        assert_eq!(history.chat(&id).unwrap(), Vec::<ChatMessage>::new());
        fs::write(history.chat_path(&id), "not json").unwrap();
        assert_eq!(history.chat(&id).unwrap(), Vec::<ChatMessage>::new());
        assert!(history.save_chat(&id, convo()).unwrap());
        assert_eq!(history.chat(&id).unwrap(), convo());

        fs::write(history.chat_path(&id), r#"{"version":2,"messages":[]}"#).unwrap();
        assert!(matches!(history.chat(&id), Err(ChatError::TooNew)));
    }

    #[test]
    fn a_save_for_a_capture_that_is_not_there_writes_nothing() {
        let dir = TempDir::new("chat-no-capture");
        let history = history(&dir);
        assert!(!history.save_chat("123", convo()).unwrap());
        assert!(!history.chats_dir().exists());
    }

    #[test]
    fn a_bad_id_or_an_invalid_message_is_refused_and_touches_nothing() {
        let dir = TempDir::new("chat-refused");
        let history = history(&dir);
        let id = history.save(&tiny(), SystemTime::now()).unwrap();
        assert!(matches!(
            history.save_chat("../x", convo()),
            Err(ChatError::Invalid("historyId"))
        ));
        assert!(matches!(
            history.chat("../x"),
            Err(ChatError::Invalid("historyId"))
        ));
        let long = "x".repeat(2001);
        assert!(matches!(
            history.save_chat(&id, vec![chat::tests::user("u1", &long)]),
            Err(ChatError::Invalid("text"))
        ));
        assert!(matches!(
            history.save_chat(&id, vec![chat::tests::user("bad id", "hi")]),
            Err(ChatError::Invalid("id"))
        ));
        assert!(!history.chats_dir().exists());
    }

    #[test]
    fn deleting_a_capture_deletes_its_conversation() {
        let dir = TempDir::new("chat-delete");
        let history = history(&dir);
        let base = SystemTime::now();
        let first = history.save(&tiny(), base).unwrap();
        let second = history.save(&tiny(), base + millis(1)).unwrap();
        history.save_chat(&first, convo()).unwrap();
        history.save_chat(&second, convo()).unwrap();

        history.delete(&first).unwrap();
        assert_eq!(chat_files(&history), [format!("{second}.json")]);

        history.delete_all().unwrap();
        assert_eq!(chat_files(&history), Vec::<String>::new());
    }

    #[test]
    fn pruning_removes_the_conversation_of_an_old_capture_and_leftovers() {
        let dir = TempDir::new("chat-prune");
        let history = history(&dir);
        let now = SystemTime::now();
        let day = Duration::from_secs(24 * 60 * 60);
        let old = history.save(&tiny(), now - day * 31).unwrap();
        let recent = history.save(&tiny(), now - day).unwrap();
        history.save_chat(&old, convo()).unwrap();
        history.save_chat(&recent, convo()).unwrap();
        fs::write(history.chats_dir().join("5.json.tmp"), "x").unwrap();
        fs::write(history.chats_dir().join("9.json"), "{}").unwrap();

        history.prune(now);

        assert_eq!(chat_files(&history), [format!("{recent}.json")]);
    }
}
