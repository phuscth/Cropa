//! Saving the beautified image: data-URL validation, file naming, atomic
//! writes, and the files this run has saved (for "show in folder"). Pure logic
//! and state; the dialogs and Tauri commands live elsewhere.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use base64::Engine;
use chrono::{DateTime, Local, NaiveDateTime};
use serde::{Deserialize, Serialize};
use specta::Type;

/// The largest image Cropa accepts from the WebView, decoded.
pub const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;

/// Most numbered copies (`name-1.png` … `name-999.png`) tried for one name.
const MAX_NAME_SUFFIX: u32 = 999;

/// An image file format the editor can export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Png,
    Jpeg,
    Webp,
}

impl ExportFormat {
    pub const ALL: [Self; 3] = [Self::Png, Self::Jpeg, Self::Webp];

    #[must_use]
    pub const fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
        }
    }

    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }

    /// Whether `bytes` start with this format's file signature.
    #[must_use]
    pub fn matches_magic(self, bytes: &[u8]) -> bool {
        match self {
            Self::Png => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
            Self::Jpeg => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
            Self::Webp => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        }
    }

    /// The format a file extension names (`png`, `jpg`, `jpeg`, `webp`), any case.
    #[must_use]
    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension.to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ExportError {
    #[error("the image is not a valid data URL for the expected format")]
    Invalid,
    #[error("the image is larger than {0} MB")]
    TooLarge(u32),
}

/// Decode `data:<mime>;base64,<data>` for `format`. The prefix must name that
/// format exactly, the encoded size is checked before decoding, and the bytes
/// must start with the format's signature.
pub fn decode_data_url(data_url: &str, format: ExportFormat) -> Result<Vec<u8>, ExportError> {
    decode_data_url_within(data_url, format, MAX_EXPORT_BYTES)
}

fn decode_data_url_within(
    data_url: &str,
    format: ExportFormat,
    max_bytes: usize,
) -> Result<Vec<u8>, ExportError> {
    let prefix = format!("data:{};base64,", format.mime());
    let encoded = data_url.strip_prefix(&prefix).ok_or(ExportError::Invalid)?;
    if encoded.len() > max_bytes.div_ceil(3) * 4 {
        return Err(too_large(max_bytes));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| ExportError::Invalid)?;
    if bytes.len() > max_bytes {
        return Err(too_large(max_bytes));
    }
    if !format.matches_magic(&bytes) {
        return Err(ExportError::Invalid);
    }
    Ok(bytes)
}

fn too_large(max_bytes: usize) -> ExportError {
    ExportError::TooLarge(u32::try_from(max_bytes / (1024 * 1024)).unwrap_or(u32::MAX))
}

/// `Cropa 2026-11-12 21.35.07`: the default name of a quick-saved capture.
#[must_use]
pub fn capture_file_stem(local: NaiveDateTime) -> String {
    local.format("Cropa %Y-%m-%d %H.%M.%S").to_string()
}

/// A capture time (Unix milliseconds) in local time. No value, or one that is
/// not a finite, representable time, falls back to now.
#[must_use]
pub fn local_capture_time(captured_at_ms: Option<f64>) -> NaiveDateTime {
    let parsed = if let Some(ms) = captured_at_ms.filter(|ms| ms.is_finite()) {
        // Saturating cast: anything out of range is rejected below.
        #[allow(clippy::cast_possible_truncation)]
        DateTime::from_timestamp_millis(ms as i64)
    } else {
        None
    };
    parsed.map_or_else(
        || Local::now().naive_local(),
        |utc| utc.with_timezone(&Local).naive_local(),
    )
}

/// Create `dir/<stem>.<ext>`, or `<stem>-1.<ext>`, `<stem>-2.<ext>` … when the
/// name is taken, and write `bytes` to it. The name is claimed atomically, so
/// an existing file is never overwritten. A file whose bytes could not be
/// written is removed again.
pub fn write_new_file(dir: &Path, stem: &str, ext: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    for n in 0..=MAX_NAME_SUFFIX {
        let name = if n == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        let path = dir.join(name);
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        };
        if let Err(err) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(err);
        }
        return Ok(path);
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("{MAX_NAME_SUFFIX} files named like this already exist"),
    ))
}

/// Replace the content of `path`: write a temp file next to it, then rename
/// over it, so a failed write never leaves half an image behind.
pub fn overwrite_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".cropa-tmp");
    let tmp = path.with_file_name(tmp_name);
    let written = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })()
    .and_then(|()| fs::rename(&tmp, path));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const MAX_STEM_CHARS: usize = 120;
const FALLBACK_STEM: &str = "Cropa";

/// A file name stem that is safe to offer in the Save as dialog: no directory
/// part, no characters Windows forbids, no image extension, no reserved device
/// name. Falls back to `Cropa`.
#[must_use]
pub fn sanitize_file_stem(suggested: &str) -> String {
    let name = suggested.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut stem: String = name
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .collect();
    if let Some((before, after)) = stem.rsplit_once('.')
        && ExportFormat::from_extension(after).is_some()
    {
        stem.truncate(before.len());
    }
    let capped: String = stem.chars().take(MAX_STEM_CHARS).collect();
    let stem = capped.trim_matches(' ').trim_end_matches(['.', ' ']);
    let device = stem.split('.').next().unwrap_or_default().trim_end();
    if stem.is_empty()
        || RESERVED_NAMES
            .iter()
            .any(|r| r.eq_ignore_ascii_case(device))
    {
        FALLBACK_STEM.to_owned()
    } else {
        stem.to_owned()
    }
}

/// A file this run saved, as the WebView may refer to it by id.
#[derive(Debug, Clone)]
pub struct SavedEntry {
    pub path: PathBuf,
    pub format: ExportFormat,
    /// Saved by Ctrl+S: a later quick save of the same image replaces it.
    pub quick: bool,
    /// The editor image this file was saved from.
    pub generation: u64,
}

/// The destination the user picked in the Save as dialog, waiting for the
/// image to be written.
#[derive(Debug, Clone)]
struct PendingSaveAs {
    token: u32,
    path: PathBuf,
    format: ExportFormat,
}

#[derive(Default)]
struct SavedFilesInner {
    next_id: u32,
    files: HashMap<u32, SavedEntry>,
    pending_save_as: Option<PendingSaveAs>,
    last_save_as_dir: Option<PathBuf>,
}

impl SavedFilesInner {
    fn next(&mut self) -> u32 {
        self.next_id = self.next_id.wrapping_add(1);
        self.next_id
    }
}

/// Files saved in this run and the pending Save as choice. The WebView only
/// ever holds the ids: it never supplies a path to write or reveal.
#[derive(Default)]
pub struct SavedFiles {
    inner: Mutex<SavedFilesInner>,
    /// Held while a save runs, dialogs included, so saves never overlap.
    save_lock: Mutex<()>,
}

impl SavedFiles {
    fn lock(&self) -> MutexGuard<'_, SavedFilesInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Wait for any running save to finish, then block new ones until dropped.
    pub fn hold_save_lock(&self) -> MutexGuard<'_, ()> {
        self.save_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub fn register(
        &self,
        path: PathBuf,
        format: ExportFormat,
        quick: bool,
        generation: u64,
    ) -> u32 {
        let mut inner = self.lock();
        let id = inner.next();
        inner.files.insert(
            id,
            SavedEntry {
                path,
                format,
                quick,
                generation,
            },
        );
        id
    }

    pub fn get(&self, id: u32) -> Option<SavedEntry> {
        self.lock().files.get(&id).cloned()
    }

    /// The entry for `id` when it was quick-saved in `format` from the editor
    /// image of `generation`.
    pub fn quick_entry(
        &self,
        id: u32,
        format: ExportFormat,
        generation: u64,
    ) -> Option<SavedEntry> {
        self.get(id)
            .filter(|entry| entry.quick && entry.format == format && entry.generation == generation)
    }

    /// Remember a Save as destination, replacing an older one, and return the
    /// token that claims it.
    pub fn set_pending_save_as(&self, path: PathBuf, format: ExportFormat) -> u32 {
        let mut inner = self.lock();
        let token = inner.next();
        inner.pending_save_as = Some(PendingSaveAs {
            token,
            path,
            format,
        });
        token
    }

    /// Take the pending destination when `token` is the one handed out last.
    pub fn take_pending_save_as(&self, token: u32) -> Option<(PathBuf, ExportFormat)> {
        let mut inner = self.lock();
        if inner
            .pending_save_as
            .as_ref()
            .is_some_and(|pending| pending.token == token)
        {
            inner
                .pending_save_as
                .take()
                .map(|pending| (pending.path, pending.format))
        } else {
            None
        }
    }

    pub fn last_save_as_dir(&self) -> Option<PathBuf> {
        self.lock().last_save_as_dir.clone()
    }

    pub fn set_last_save_as_dir(&self, dir: PathBuf) {
        self.lock().last_save_as_dir = Some(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "cropa-export-{tag}-{}-{:?}",
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

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2];
    const WEBP: &[u8] = b"RIFF\x10\x00\x00\x00WEBPVP8 ";

    fn url(mime: &str, bytes: &[u8]) -> String {
        format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn capture_file_stem_is_zero_padded() {
        let time = NaiveDate::from_ymd_opt(2026, 1, 2)
            .unwrap()
            .and_hms_opt(3, 4, 5)
            .unwrap();
        assert_eq!(capture_file_stem(time), "Cropa 2026-01-02 03.04.05");
    }

    #[test]
    fn a_bad_capture_time_falls_back_to_now() {
        let year = |ms: f64| chrono::Datelike::year(&local_capture_time(Some(ms)));
        let now = chrono::Datelike::year(&Local::now());
        assert_eq!(chrono::Datelike::year(&local_capture_time(None)), now);
        assert_eq!(year(f64::NAN), now);
        assert_eq!(year(f64::INFINITY), now);
        assert_eq!(year(1e300), now);
        assert_eq!(year(1_700_000_000_000.0), 2023);
    }

    #[test]
    fn write_new_file_never_overwrites() {
        let dir = TempDir::new("write");
        let first = write_new_file(&dir.0, "shot", "png", b"one").unwrap();
        assert_eq!(first, dir.0.join("shot.png"));
        let second = write_new_file(&dir.0, "shot", "png", b"two").unwrap();
        assert_eq!(second, dir.0.join("shot-1.png"));
        let third = write_new_file(&dir.0, "shot", "png", b"three").unwrap();
        assert_eq!(third, dir.0.join("shot-2.png"));
        assert_eq!(fs::read(&first).unwrap(), b"one");
        assert_eq!(fs::read(&second).unwrap(), b"two");
        assert_eq!(fs::read(&third).unwrap(), b"three");
    }

    #[test]
    fn overwrite_file_replaces_content_and_leaves_no_temp_file() {
        let dir = TempDir::new("overwrite");
        let path = dir.0.join("shot.png");
        fs::write(&path, b"old").unwrap();
        overwrite_file(&path, b"new content").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new content");
        let names: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["shot.png"]);
    }

    #[test]
    fn decode_accepts_each_format() {
        for (format, bytes) in [
            (ExportFormat::Png, PNG),
            (ExportFormat::Jpeg, JPEG),
            (ExportFormat::Webp, WEBP),
        ] {
            let decoded = decode_data_url(&url(format.mime(), bytes), format).unwrap();
            assert_eq!(decoded, bytes);
        }
    }

    #[test]
    fn decode_rejects_a_mismatch() {
        // PNG bytes declared as JPEG, and a prefix for another format.
        assert_eq!(
            decode_data_url(&url("image/jpeg", PNG), ExportFormat::Jpeg),
            Err(ExportError::Invalid)
        );
        assert_eq!(
            decode_data_url(&url("image/png", PNG), ExportFormat::Jpeg),
            Err(ExportError::Invalid)
        );
        // A truncated signature, bad base64, and a missing prefix.
        assert_eq!(
            decode_data_url(&url("image/png", &PNG[..4]), ExportFormat::Png),
            Err(ExportError::Invalid)
        );
        assert_eq!(
            decode_data_url("data:image/png;base64,@@@", ExportFormat::Png),
            Err(ExportError::Invalid)
        );
        assert_eq!(
            decode_data_url("iVBORw0KGgo=", ExportFormat::Png),
            Err(ExportError::Invalid)
        );
    }

    #[test]
    fn decode_enforces_the_size_cap() {
        let data = url("image/png", PNG);
        assert!(decode_data_url_within(&data, ExportFormat::Png, PNG.len()).is_ok());
        assert_eq!(
            decode_data_url_within(&data, ExportFormat::Png, PNG.len() - 1),
            Err(ExportError::TooLarge(0))
        );
        // Far too long: rejected from its length, before any decoding.
        let huge = format!("data:image/png;base64,{}", "A".repeat(100));
        assert_eq!(
            decode_data_url_within(&huge, ExportFormat::Png, 3),
            Err(ExportError::TooLarge(0))
        );
    }

    #[test]
    fn sanitize_file_stem_handles_hostile_names() {
        assert_eq!(sanitize_file_stem("..\\..\\evil\\name"), "name");
        assert_eq!(sanitize_file_stem("C:/Users/me/shot"), "shot");
        assert_eq!(sanitize_file_stem("a<b>c:d\"e|f?g*h"), "abcdefgh");
        assert_eq!(sanitize_file_stem("report...   "), "report");
        assert_eq!(sanitize_file_stem("shot.PNG"), "shot");
        assert_eq!(sanitize_file_stem("shot.jpeg"), "shot");
        assert_eq!(sanitize_file_stem("v1.2"), "v1.2");
        assert_eq!(sanitize_file_stem("tab\there"), "tabhere");
        assert_eq!(sanitize_file_stem("CON"), "Cropa");
        assert_eq!(sanitize_file_stem("nul.txt"), "Cropa");
        assert_eq!(sanitize_file_stem("com1"), "Cropa");
        assert_eq!(sanitize_file_stem(""), "Cropa");
        assert_eq!(sanitize_file_stem("  . "), "Cropa");
        assert_eq!(sanitize_file_stem(&"x".repeat(300)).chars().count(), 120);
    }

    #[test]
    fn from_extension_ignores_case() {
        assert_eq!(ExportFormat::from_extension("PNG"), Some(ExportFormat::Png));
        assert_eq!(
            ExportFormat::from_extension("Jpg"),
            Some(ExportFormat::Jpeg)
        );
        assert_eq!(
            ExportFormat::from_extension("JPEG"),
            Some(ExportFormat::Jpeg)
        );
        assert_eq!(
            ExportFormat::from_extension("webP"),
            Some(ExportFormat::Webp)
        );
        assert_eq!(ExportFormat::from_extension("gif"), None);
    }

    #[test]
    fn a_pending_save_as_is_claimed_once_by_the_latest_token() {
        let files = SavedFiles::default();
        let old = files.set_pending_save_as(PathBuf::from("a.png"), ExportFormat::Png);
        let new = files.set_pending_save_as(PathBuf::from("b.webp"), ExportFormat::Webp);
        assert!(files.take_pending_save_as(old).is_none());
        let (path, format) = files.take_pending_save_as(new).unwrap();
        assert_eq!(path, PathBuf::from("b.webp"));
        assert_eq!(format, ExportFormat::Webp);
        assert!(files.take_pending_save_as(new).is_none());
    }

    #[test]
    fn only_a_quick_save_of_the_same_format_is_replaced() {
        let files = SavedFiles::default();
        let quick = files.register(PathBuf::from("q.png"), ExportFormat::Png, true, 7);
        let manual = files.register(PathBuf::from("m.png"), ExportFormat::Png, false, 7);
        assert!(files.quick_entry(quick, ExportFormat::Png, 7).is_some());
        assert!(files.quick_entry(quick, ExportFormat::Jpeg, 7).is_none());
        assert!(files.quick_entry(manual, ExportFormat::Png, 7).is_none());
        assert!(files.quick_entry(999, ExportFormat::Png, 7).is_none());
        // The editor moved on to another image since the file was saved.
        assert!(files.quick_entry(quick, ExportFormat::Png, 8).is_none());
    }
}
