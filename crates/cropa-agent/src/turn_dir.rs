//! A fresh scratch directory for one turn, removed when dropped.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

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
        let parent = std::env::temp_dir().join("cropa-agent");
        std::fs::create_dir_all(&parent)?;
        let path = parent.join(name);
        std::fs::create_dir(&path)?;
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
