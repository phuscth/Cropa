//! A fresh scratch directory for one turn, removed when dropped.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A directory builder; on unix the folders are readable by the user only.
fn private_dir_builder(recursive: bool) -> std::fs::DirBuilder {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
}

fn root() -> PathBuf {
    std::env::temp_dir().join("cropa-agent")
}

/// True for `<pid>-<counter>-<nanos>`, the names `TurnDir::new` makes.
fn stale_pid(name: &str) -> Option<u32> {
    let mut parts = name.split('-');
    let pid = parts.next()?.parse().ok()?;
    let digits =
        |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    (digits(parts.next()) && digits(parts.next()) && parts.next().is_none()).then_some(pid)
}

fn remove_stale_in(root: &Path, current_pid: u32) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    let mut failed = None;
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(stale_pid) else {
            continue;
        };
        if pid == current_pid || !entry.path().is_dir() {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => removed += 1,
            Err(err) => failed = Some(err.kind()),
        }
    }
    if let Some(kind) = failed {
        log::warn!("could not remove some old turn folders: {kind:?}");
    }
    removed
}

/// Deletes the turn folders that earlier runs of Cropa left behind (a crash
/// or a kill skips `Drop`). Best effort; returns how many were removed.
pub fn remove_stale() -> usize {
    let removed = remove_stale_in(&root(), std::process::id());
    if removed > 0 {
        log::info!("removed {removed} old turn folders");
    }
    removed
}

#[derive(Debug)]
pub struct TurnDir {
    path: PathBuf,
}

impl TurnDir {
    /// Creates `<temp>/cropa-agent/<pid>-<counter>-<nanos>`. `create_dir`
    /// fails when the path exists, so the directory is always new and empty.
    pub fn new() -> io::Result<Self> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let name = format!(
            "{}-{}-{nanos}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let parent = root();
        private_dir_builder(true).create(&parent)?;
        let path = parent.join(name);
        private_dir_builder(false).create(&path)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TurnDir {
    fn drop(&mut self) {
        // A killed child may hold a handle on Windows for a moment.
        let attempts = if cfg!(windows) { 5 } else { 1 };
        let mut last = None;
        for attempt in 0..attempts {
            match std::fs::remove_dir_all(&self.path) {
                Ok(()) => return,
                Err(err) if err.kind() == io::ErrorKind::NotFound => return,
                Err(err) => last = Some(err.kind()),
            }
            if attempt + 1 < attempts {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if let Some(kind) = last {
            log::warn!(
                "could not remove turn dir {}: {kind:?}",
                self.path
                    .file_name()
                    .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_folders_of_other_processes_are_removed() {
        let live = TurnDir::new().unwrap();
        let root = live.path().join("root");
        let old = root.join("1-0-5");
        let mine = root.join("7-0-5");
        let other = root.join("notes");
        for dir in [&old, &mine, &other] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(old.join("input-0.png"), b"x").unwrap();
        assert_eq!(remove_stale_in(&root, 7), 1);
        assert!(!old.exists());
        assert!(mine.exists());
        assert!(other.exists());
    }

    #[test]
    fn each_dir_is_new_and_removed_on_drop() {
        let a = TurnDir::new().unwrap();
        let b = TurnDir::new().unwrap();
        assert_ne!(a.path(), b.path());
        assert!(a.path().is_dir());
        std::fs::write(a.path().join("f.txt"), b"x").unwrap();
        let path = a.path().to_path_buf();
        drop(a);
        assert!(!path.exists());
        assert!(b.path().is_dir());
    }
}
